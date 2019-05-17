'use strict';

const http = require('http');
const httpProxy = require('http-proxy');
const validUrl = require('valid-url');
const parseUrl = require('url').parse;
const path = require('path');
const _ = require('lodash');
const hash = require('object-hash');
const LRUCache = require("lru-cache");
const routeCache = new LRUCache({ max: 5000 })

const startsWith = (input, str) =>
  input.slice(0, str.length) === str &&
    (input.length === str.length || input[str.length] === '/')

const setHttp = link => {
  if (link.search(/^http[s]?\:\/\//) === -1) {
    link = 'http://' + link;
  }

  return link;
}

const prepareUrl = url => {
  url = _.clone(url);
  if (_.isString(url)) {
    url = setHttp(url);

    if (!validUrl.isHttpUri(url) && !validUrl.isHttpsUri(url)) {
      throw Error('uri is not a valid http uri ' + url);
    }

    url = parseUrl(url);
  }
  return url;
};

const buildTarget = (target, { useTargetHostHeader } = {}) => {
  target = prepareUrl(target);
  target.useTargetHostHeader = useTargetHostHeader;
  return target;
};

const buildRoute = route => {
  if (!_.isString(route) && !_.isObject(route)) {
    return null;
  }

  if (_.isObject(route) && route.hasOwnProperty('urls') && route.hasOwnProperty('path')) {
    // default route type matched.
    return route;
  }

  const cacheKey = _.isString(route) ? route : hash(route);
  const entry = routeCache.get(cacheKey);

  if (entry) {
    return entry;
  }

  const routeObject = { rr: 0, isResolved: true };
  if (_.isString(route)) {
    routeObject.urls = [buildTarget(route)];
    routeObject.path = '/';
  } else {
    if (!route.hasOwnProperty('url')) {
      return null;
    }

    routeObject.urls = (_.isArray(route.url) ? route.url : [route.url]).map(url => {
      return buildTarget(url, route.opts);
    });

    routeObject.path = route.path || '/';
  }

  routeCache.set(cacheKey, routeObject);
  return routeObject;
};

const defaultRespondNotFound = (_, res) => {
  res.statusCode = 404;
  res.write('Not Found');
  res.end();
};

const ReverseProxy = ({
  errorHandler,
  host,
  port = 8080,
  preferForwardedHost,
  resolvers: sourceResolvers,
  respondNotFound = defaultRespondNotFound,
  xfwd
} = {}) => {
  const routing = {};

  const defaultResolver = (host, url) => {
    // Given a src resolve it to a target route if any available.
    if (!host) {
      return;
    }

    url = url || '/';

    const routes = routing[host];

    if (routes) {
      const len = routes.length;

      //
      // Find path that matches the start of req.url
      //
      for (let i = 0; i < len; i++) {
        const route = routes[i];

        if (route.path === '/' || startsWith(url, route.path)) {
          return route;
        }
      }
    }
  };

  defaultResolver.priority = 0;

  let resolvers = [defaultResolver];

  if (sourceResolvers) {
    addResolver(sourceResolvers);
  }

  const addResolver = (resolver) => {
    if (!Array.isArray(resolver)) {
      resolver = [resolver];
    }

    resolver.forEach(resolveObj => {
      resolveObj.priority = resolveObj.priority || 0;
      resolvers.push(resolveObj);
    });

    resolvers = _.sortBy(_.uniq(resolvers), ['priority']).reverse();
  };

  const removeResolver = resolver => {
    // since unique resolvers are not checked for performance,
    // just remove every existence.
    resolvers = resolvers.filter(resolverFn => {
      return resolverFn !== resolver;
    });
  };

  //
  // Create a proxy server with custom application logic
  //
  const proxy = httpProxy.createProxyServer({
    xfwd,
    prependPath: false
  });

  proxy.on('proxyReq', (p, req) => {
    if (req.host != null) {
      p.setHeader('host', req.host);
    }
  });

  const resolve = async (host, url, req) => {
    let promiseArray = [];

    host = host && host.toLowerCase();

    for (let i = 0; i < resolvers.length; i++) {
      promiseArray.push(resolvers[i](host, url, req));
    }

    try {
      const resolverResults = await Promise.all(promiseArray);

      for (let i=0; i<resolverResults.length; i++) {
        let route = resolverResults[i];

        if (route && (route = buildRoute(route))) {
          // ensure resolved route has path that prefixes URL
          // no need to check for native routes.
          if (!route.isResolved || route.path === '/' || startsWith(url, route.path)) {
            return route;
          }
        }
      }
    }
    catch (error) {
      console.error('Resolvers error:', error)
    }
  };

  const setupHttpProxy = proxy => {
    const getSource = req => {
      if (preferForwardedHost && req.headers['x-forwarded-host']) {
        return req.headers['x-forwarded-host'].split(':')[0];
      }

      if (req.headers.host) {
        return req.headers.host.split(':')[0];
      }
    }

    const getTarget = async (src, req) => {
      const { url } = req;

      const route = await resolve(src, url, req);

        if (!route) {
          console.warn({ src: src, url: url }, 'no valid route found for given source');
          return;
        }

        const { path: pathname } = route;

        if (pathname.length > 1) {
          //
          // remove prefix from src
          //
          req._url = url; // save original url
          req.url = url.substr(pathname.length) || '/';
        }

        //
        // Perform Round-Robin on the available targets
        // TODO: if target errors with EHOSTUNREACH we should skip this
        // target and try with another.
        //

        const { urls, rr: j } = route;

        route.rr = (j + 1) % urls.length; // get and update Round-robin index.
        const target = urls[j];

        //
        // Fix request url if targetname specified.
        //
        if (target.pathname) {
          req.url = path.posix.join(target.pathname, req.url);
        }

        //
        // Host headers are passed through from the source by default
        // Often we want to use the host header of the target instead
        //
        if (target.useTargetHostHeader === true) {
          req.host = target.host;
        }

        console.log('Proxying %s to %s', src + url, path.join(target.host, req.url));

        return target;
    };

    const server = http.createServer(async (req, res) => {
      const src = getSource(req);

      const target = await getTarget(src, req);

      if (target){
        proxy.web(req, res, { target });
      } else {
        respondNotFound(req, res);
      }
    });

    server.on('error', function (err) {
      console.error(err, 'Server Error');
    });

    return server;
  }

  const server = setupHttpProxy(proxy, log);

  server.listen(port, host);

  if (errorHandler) {
    proxy.on('error', errorHandler);
  } else {
    const handleProxyError = (err, _, res) => {
      //
      // Send a 500 http status if headers have been sent
      //

      if (err.code === 'ECONNREFUSED') {
        res.writeHead && res.writeHead(502);
      } else if (!res.headersSent) {
        res.writeHead && res.writeHead(500);
      }

      //
      // Do not log this common error
      //
      if (err.message !== 'socket hang up') {
        console.error(err, 'Proxy Error');
      }

      //
      // TODO: if err.code=ECONNREFUSED and there are more servers
      // for this route, try another one.
      //
      res.end(err.code)
    }

    proxy.on('error', handleProxyError);
  }

  console.log(`Started a Redbird reverse proxy server on port ${port}`);

  const register = (src, target, opts) => {
    if (!src || !target) {
      throw Error('Cannot register a new route with unspecified src or target');
    }

    src = prepareUrl(src);

    target = buildTarget(target, opts);

    const host = routing[src.hostname] = routing[src.hostname] || [];
    const pathname = src.pathname || '/';
    let route = _.find(host, { path: pathname });

    if (!route) {
      route = { path: pathname, rr: 0, urls: [] };
      host.push(route);

      //
      // Sort routes
      //
      routing[src.hostname] = _.sortBy(host, _route => {
        return -_route.path.length;
      });
    }

    route.urls.push(target);

    console.log({ from: src, to: target }, 'Registered a new route');
  };

  const unregister = (src, target) => {
    if (!src) {
      return;
    }

    src = prepareUrl(src);
    const routes = routing[src.hostname] || [];
    const pathname = src.pathname || '/';

    let i = 0;

    for (i = 0; i < routes.length; i++) {
      if (routes[i].path === pathname) {
        break;
      }
    }

    if (i < routes.length) {
      const route = routes[i];

      if (target) {
        target = prepareUrl(target);
        _.remove(route.urls, url => (
          url.href === target.href
        ));
      } else {
        route.urls = [];
      }

      if (route.urls.length === 0) {
        routes.splice(i, 1);
      }

      console.log({ from: src, to: target }, 'Unregistered a route');
    }
  };

  const close = () => {
    try {
      server.close();
    } catch (error) {
      console.error(error);
    }
  };

  return {
    addResolver,
    close,
    register,
    removeResolver,
    unregister
  };
}

module.exports = ReverseProxy;
