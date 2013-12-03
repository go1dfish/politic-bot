var couchbase   = require('couchbase'),
    RSVP        = require('rsvp');

function CouchRSVP(cb) {
  this.set = function(key, value) {
    return RSVP.Promise(function(resolve, reject) {
      cb.set(key, value, function(error) {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      });
    });
  };

  this.getMulti = function(keys, value) {
    return RSVP.Promise(function(resolve, reject) {
      cb.getMulti(keys, null, function(error, results) {
        if (error) {
          reject(error);
        } else {
          resolve(results);
        }
      });
    });
  };

  this.get = function(key) {
    return RSVP.Promise(function(resolve, reject) {
      cb.get(key, null, function(error, result) {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  };

  this.queryView = function(designDoc, viewName, args) {
    var view = cb.view(designDoc, viewName, args);
    return RSVP.Promise(function(resolve, reject) {
      view.query(function(error, results) {
        if (error) {
          reject(error);
        } else {
          resolve(results);
        }
      });
    });
  }
}

module.exports = {
  connect: function(args) {
    return RSVP.Promise(function(resolve, reject) {
      var cb = new couchbase.Connection(args, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(new CouchRSVP(cb));
        }
      });
    });
  },
};
