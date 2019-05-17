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

function ReverseProxy(opts) {
  if (!(this instanceof ReverseProxy)) {
    return new ReverseProxy(opts);
  }

  this.opts = opts = opts || {};

  if (this.opts.httpProxy == undefined) {
        this.opts.httpProxy = {};
  }

  const log = {
    error: (...args) => console.error(...args),
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args)
  };

  var _this = this;

  this.resolvers = [this._defaultResolver];

  opts.port = opts.port || 8080;

  if (opts.resolvers) {
    this.addResolver(opts.resolvers);
  }

  //
  // Routing table.
  //
  this.routing = {};

  //
  // Create a proxy server with custom application logic
  //
  var proxy = this.proxy = httpProxy.createProxyServer({
    xfwd: (opts.xfwd != false),
    prependPath: false,
    secure: (opts.secure !== false),
    /*
    agent: new http.Agent({
      keepAlive: true
    })
    */
  });

  proxy.on('proxyReq', function (p, req) {
    if (req.host != null) {
      p.setHeader('host', req.host);
    }
  });

  //
  // Plain HTTP Proxy
  //
  var server = this.setupHttpProxy(proxy, websocketsUpgrade, log, opts);

  server.listen(opts.port, opts.host);

  if (opts.errorHandler && _.isFunction(opts.errorHandler)) {
    proxy.on('error', opts.errorHandler);
  } else {
    proxy.on('error', handleProxyError);
  }

  log && log.info('Started a Redbird reverse proxy server on port %s', opts.port);

  function websocketsUpgrade(req, socket, head) {
    socket.on('error', function (err) {
      log && log.error(err, 'WebSockets error');
    });
    var src = _this._getSource(req);
    _this._getTarget(src, req).then(function (target) {
      log && log.info({ headers: req.headers, target: target }, 'upgrade to websockets');
      if (target) {
        proxy.ws(req, socket, head, { target: target });
      } else {
        respondNotFound(req, socket);
      }
    });
  }

  function handleProxyError(err, req, res) {
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
      log && log.error(err, 'Proxy Error');
    }

    //
    // TODO: if err.code=ECONNREFUSED and there are more servers
    // for this route, try another one.
    //
    res.end(err.code)
  }
}

ReverseProxy.prototype.setupHttpProxy = function (proxy, websocketsUpgrade, log, opts) {
  var _this = this;
  var httpServerModule = opts.serverModule || http;
  var server = this.server = httpServerModule.createServer(function (req, res) {
    var src = _this._getSource(req);
    _this._getTarget(src, req).bind(_this).then(function (target) {
      if (target){
        proxy.web(req, res, { target: target, secure: (proxy.options && proxy.options.secure) || true});
      } else {
        respondNotFound(req, res);
      }
    });
  });

  //
  // Listen to the `upgrade` event and proxy the
  // WebSocket requests as well.
  //
  server.on('upgrade', websocketsUpgrade);

  server.on('error', function (err) {
    log && log.error(err, 'Server Error');
  });

  return server;
}

ReverseProxy.prototype.addResolver = function (resolver) {
  if (!_.isArray(resolver)) {
    resolver = [resolver];
  }

  var _this = this;
  resolver.forEach(function (resolveObj) {
    if (!_.isFunction(resolveObj)) {
      throw new Error("Resolver must be an invokable function.");
    }

    if (!resolveObj.hasOwnProperty('priority')) {
      resolveObj.priority = 0;
    }

    _this.resolvers.push(resolveObj);
  });

  _this.resolvers = _.sortBy(_.uniq(_this.resolvers), ['priority']).reverse();
};

ReverseProxy.prototype.removeResolver = function (resolver) {
  // since unique resolvers are not checked for performance,
  // just remove every existence.
  this.resolvers = this.resolvers.filter(function (resolverFn) {
    return resolverFn !== resolver;
  });
};

ReverseProxy.buildTarget = function (target, opts) {
  opts = opts || {};
  target = prepareUrl(target);
  target.useTargetHostHeader = opts.useTargetHostHeader === true;
  return target;
};

/**
 Register a new route.

 @src {String|URL} A string or a url parsed by node url module.
 Note that port is ignored, since the proxy just listens to one port.

 @target {String|URL} A string or a url parsed by node url module.
 @opts {Object} Route options.
 */
ReverseProxy.prototype.register = function (src, target, opts) {
  if (!src || !target) {
    throw Error('Cannot register a new route with unspecified src or target');
  }

  var routing = this.routing;

  src = prepareUrl(src);

  target = ReverseProxy.buildTarget(target, opts);

  var host = routing[src.hostname] = routing[src.hostname] || [];
  var pathname = src.pathname || '/';
  var route = _.find(host, { path: pathname });

  if (!route) {
    route = { path: pathname, rr: 0, urls: [] };
    host.push(route);

    //
    // Sort routes
    //
    routing[src.hostname] = _.sortBy(host, function (_route) {
      return -_route.path.length;
    });
  }

  route.urls.push(target);

  this.log && this.log.info({ from: src, to: target }, 'Registered a new route');
  return this;
};

ReverseProxy.prototype.unregister = function (src, target) {
  if (!src) {
    return this;
  }

  src = prepareUrl(src);
  var routes = this.routing[src.hostname] || [];
  var pathname = src.pathname || '/';
  var i;

  for (i = 0; i < routes.length; i++) {
    if (routes[i].path === pathname) {
      break;
    }
  }

  if (i < routes.length) {
    var route = routes[i];

    if (target) {
      target = prepareUrl(target);
      _.remove(route.urls, function (url) {
        return url.href === target.href;
      });
    } else {
      route.urls = [];
    }

    if (route.urls.length === 0) {
      routes.splice(i, 1);
    }

    this.log && this.log.info({ from: src, to: target }, 'Unregistered a route');
  }
  return this;
};

ReverseProxy.prototype._defaultResolver = function (host, url) {
  // Given a src resolve it to a target route if any available.
  if (!host) {
    return;
  }

  url = url || '/';

  var routes = this.routing[host];
  var i = 0;

  if (routes) {
    var len = routes.length;

    //
    // Find path that matches the start of req.url
    //
    for (i = 0; i < len; i++) {
      var route = routes[i];

      if (route.path === '/' || startsWith(url, route.path)) {
        return route;
      }
    }
  }
};

ReverseProxy.prototype._defaultResolver.priority = 0;

/**
 * Resolves to route
 * @param host
 * @param url
 * @returns {*}
 */
ReverseProxy.prototype.resolve = function (host, url, req) {
  var resolvedValue;
  var promiseArray = [];

  host = host && host.toLowerCase();
  for (var i = 0; i < this.resolvers.length; i++) {
    promiseArray.push(this.resolvers[i].call(this,host, url, req));
  }

  return Promise.all(promiseArray).then(function (resolverResults) {
    for (var i=0; i<resolverResults.length; i++) {
      var route = resolverResults[i];

      if (route && (route = ReverseProxy.buildRoute(route))) {
        // ensure resolved route has path that prefixes URL
        // no need to check for native routes.
        if (!route.isResolved || route.path === '/' || startsWith(url, route.path)) {
          return route;
        }
      }
    }
  })
    .catch(function(error) {
      console.error('Resolvers error:',error)
    });
};


ReverseProxy.buildRoute = function (route) {
  if (!_.isString(route) && !_.isObject(route)) {
    return null;
  }

  if (_.isObject(route) && route.hasOwnProperty('urls') && route.hasOwnProperty('path')) {
    // default route type matched.
    return route;
  }

  var cacheKey = _.isString(route) ? route : hash(route);
  var entry = routeCache.get(cacheKey);
  if (entry) {
    return entry;
  }

  var routeObject = { rr: 0, isResolved: true };
  if (_.isString(route)) {
    routeObject.urls = [ReverseProxy.buildTarget(route)];
    routeObject.path = '/';
  } else {
    if (!route.hasOwnProperty('url')) {
      return null;
    }

    routeObject.urls = (_.isArray(route.url) ? route.url : [route.url]).map(function (url) {
      return ReverseProxy.buildTarget(url, route.opts || {});
    });

    routeObject.path = route.path || '/';
  }
  routeCache.set(cacheKey, routeObject);
  return routeObject;
};

ReverseProxy.prototype._getTarget = function (src, req) {
  var url = req.url;

  return this.resolve(src, url, req).bind(this).then(function (route) {
    if (!route) {
      this.log && this.log.warn({ src: src, url: url }, 'no valid route found for given source');
      return;
    }

    var pathname = route.path;
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
    var urls = route.urls;
    var j = route.rr;
    route.rr = (j + 1) % urls.length; // get and update Round-robin index.
    var target = route.urls[j];

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

    this.log && this.log.info('Proxying %s to %s', src + url, path.join(target.host, req.url));

    return target;
  });
};

ReverseProxy.prototype._getSource = function (req) {
  if (this.opts.preferForwardedHost === true && req.headers['x-forwarded-host']) {
    return req.headers['x-forwarded-host'].split(':')[0];
  }
  if (req.headers.host) {
    return req.headers.host.split(':')[0];
  }
}

ReverseProxy.prototype.close = function () {
  try {
    this.server.close();
  } catch (err) {
    // Ignore for now...
  }
};

//
// Helpers
//
/**
  Routing table structure. An object with hostname as key, and an array as value.
  The array has one element per path associated to the given hostname.
  Every path has a Round-Robin value (rr) and urls array, with all the urls available
  for this target route.

  {
    hostA :
      [
        {
          path: '/',
          rr: 3,
          urls: []
        }
      ]
  }
*/

var respondNotFound = function (req, res) {
  res.statusCode = 404;
  res.write('Not Found');
  res.end();
};

ReverseProxy.prototype.notFound = function (callback) {
  if (typeof callback == "function")
    respondNotFound = callback;
  else
    throw Error('notFound callback is not a function');
};

function startsWith(input, str) {
  return input.slice(0, str.length) === str &&
    (input.length === str.length || input[str.length] === '/')
}

function prepareUrl(url) {
  url = _.clone(url);
  if (_.isString(url)) {
    url = setHttp(url);

    if (!validUrl.isHttpUri(url) && !validUrl.isHttpsUri(url)) {
      throw Error('uri is not a valid http uri ' + url);
    }

    url = parseUrl(url);
  }
  return url;
}

function getCertData(pathname, unbundle) {
  var fs = require('fs');

  // TODO: Support input as Buffer, Stream or Pathname.

  if (pathname) {
    if (_.isArray(pathname)) {
      var pathnames = pathname;
      return _.flatten(_.map(pathnames, function (_pathname) {
        return getCertData(_pathname, unbundle);
      }));
    } else if (fs.existsSync(pathname)) {
      if (unbundle) {
        return unbundleCert(fs.readFileSync(pathname, 'utf8'));
      } else {
        return fs.readFileSync(pathname, 'utf8');
      }
    }
  }
}

//
// https://stackoverflow.com/questions/18052919/javascript-regular-expression-to-add-protocol-to-url-string/18053700#18053700
// Adds http protocol if non specified.
function setHttp(link) {
  if (link.search(/^http[s]?\:\/\//) === -1) {
    link = 'http://' + link;
  }
  return link;
}

module.exports = ReverseProxy;
