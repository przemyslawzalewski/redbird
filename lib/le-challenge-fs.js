'use strict';

var fs = require('fs');
var path = require('path');

var myDefaults = {
  //webrootPath: [ '~', 'letsencrypt', 'var', 'lib' ].join(path.sep)
  webrootPath: path.join(require('os').tmpdir(), 'acme-challenge')
, loopbackTimeout: 5 * 1000
, debug: false
};

var Challenge = module.exports;

Challenge.create = function (options) {
  var results = {};

  Object.keys(Challenge).forEach(function (key) {
    results[key] = Challenge[key];
  });
  results.create = undefined;

  Object.keys(myDefaults).forEach(function (key) {
    if ('undefined' === typeof options[key]) {
      options[key] = myDefaults[key];
    }
  });
  results._options = options;

  results.getOptions = function () {
    return results._options;
  };

  var logger = options.logger;

  logger && logger.info('Created le-challenge-fs');

  return results;
};

//
// NOTE: the "args" here in `set()` are NOT accessible to `get()` and `remove()`
// They are provided so that you can store them in an implementation-specific way
// if you need access to them.
//
Challenge.set = function (args, domain, challengePath, keyAuthorization, done) {
  var mkdirp = require('mkdirp');
  keyAuthorization = String(keyAuthorization);

  var options = this.getOptions();
  var logger = options.logger;

  logger && logger.info('Challenge.set %s', JSON.stringify({
    domain: domain,
    challengePath: challengePath,
    keyAuthorization: keyAuthorization
  }, null, 2));

  mkdirp(args.webrootPath, function (err) {
    if (err) {
      logger && logger.info('mkdirp %s', JSON.stringify({
        err
      }, null, 2));

      done(err);
      return;
    }

    var filePath = path.join(args.webrootPath, challengePath);
    logger && logger.info('writing challenge %s %s', filePath, keyAuthorization);

    fs.writeFile(filePath, keyAuthorization, 'utf8', function (err) {
      if (err)
      {
        logger && logger.info('fs.writeFile failed with %s', JSON.stringify({
          err
        }, null, 2));
      }

      logger && logger.info('fs.writeFile ok');

      done(err);
    });
  });
};


//
// NOTE: the "defaults" here are still merged and templated, just like "args" would be,
// but if you specifically need "args" you must retrieve them from some storage mechanism
// based on domain and key
//
Challenge.get = function (defaults, domain, key, done) {
  var options = this.getOptions();
  var logger = options.logger;

  logger && logger.info('Challenge.get %s', JSON.stringify({
    defaults,
    domain,
    key,
  }, null, 2));

  var filePath = path.join(defaults.webrootPath, key);
  logger && logger.info('reading challenge %s %s', filePath);

  fs.readFile(filePath, 'utf8', done);
};

Challenge.remove = function (defaults, domain, key, done) {
  var options = this.getOptions();
  var logger = options.logger;

  logger && logger.info('Challenge.remove %s', JSON.stringify({
    defaults,
    domain,
    key,
  }, null, 2));

  var filePath = path.join(defaults.webrootPath, key);
  logger && logger.info('deleting challenge %s %s', filePath);

  logger && logger.info('disabled to debug');
  //fs.unlink(path.join(defaults.webrootPath, key), done);
};

Challenge.loopback = function (defaults, domain, key, done) {
  var options = this.getOptions();
  var logger = options.logger;

  logger && logger.info('Challenge.loopback %s', JSON.stringify({
    defaults,
    domain,
    key,
  }, null, 2));

  var hostname = domain + (defaults.loopbackPort ? ':' + defaults.loopbackPort : '');
  var urlstr = 'http://' + hostname + '/.well-known/acme-challenge/' + key;

  logger && logger.info('Challenge.loopback parameters %s', JSON.stringify({
    hostname,
    urlstr,
    loopbackPort: defaults.loopbackPort,
  }, null, 2));

  require('http').get(urlstr, function (res) {
    if (200 !== res.statusCode) {
      logger && logger.info('local loopback failed with statusCode %s', JSON.stringify({
        statusCode: res.statusCode,
      }, null, 2));

      done(new Error("local loopback failed with statusCode " + res.statusCode));
      return;
    }
    var chunks = [];
    res.on('data', function (chunk) {
      chunks.push(chunk);
    });
    res.on('end', function () {
      var str = Buffer.concat(chunks).toString('utf8').trim();
      done(null, str);
    });
  }).setTimeout(defaults.loopbackTimeout, function () {
    logger && logger.info('loopback timeout, could not reach server');

    done(new Error("loopback timeout, could not reach server"));
  }).on('error', function (err) {
    logger && logger.info('on error', JSON.stringify({
      err
    }, null, 2));
    done(err);
  });
};

Challenge.test = function (args, domain, challenge, keyAuthorization, done) {
  var options = this.getOptions();
  var logger = options.logger;

  logger && logger.info('Challenge.test %s', JSON.stringify({
    domain,
    challenge,
    keyAuthorization
  }, null, 2));

  var me = this;
  var key = keyAuthorization || challenge;

  me.set(args, domain, challenge, key, function (err) {
    if (err) {
      logger && logger.info('Error during set', JSON.stringify({
        err
      }, null, 2));

      done(err);
      return;
    }

    myDefaults.loopbackPort = args.loopbackPort;
    myDefaults.webrootPath = args.webrootPath;
    me.loopback(args, domain, challenge, function (err, _key) {
      if (err) {
        logger && logger.info('Error during loopback', JSON.stringify({
          err
        }, null, 2));

        done(err);
        return;
      }

      if (key !== _key) {
        err = new Error("keyAuthorization [original] '" + key + "'"
          + " did not match [result] '" + _key + "'");

        logger && logger.info('Key check error', JSON.stringify({
          err
        }, null, 2));
        return;
      }

      me.remove(myDefaults, domain, challenge, function (_err) {
        if (_err) {
          logger && logger.info('Error during remove', JSON.stringify({
            _err
          }, null, 2));

          done(_err);
          return;
        }

        done(err);
      });
    });
  });
};
