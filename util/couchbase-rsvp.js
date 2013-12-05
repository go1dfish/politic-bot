var couchbase   = require('couchbase'),
    RSVP        = require('rsvp');

function CouchRSVP(cb) {
  var self = this;

  this.set = function(key, value) {
    return new RSVP.Promise(function(resolve, reject) {
      cb.set(key, value, function(error) {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      });
    });
  };

  this.setMulti = function(values) {
    return RSVP.all(Object.keys(values).map(function(key) {
      return self.set(key, values[key]);
    })).then(function() {return values});
  };

  this.getMulti = function(keys, value) {
    return new RSVP.Promise(function(resolve, reject) {
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
    return new RSVP.Promise(function(resolve, reject) {
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
    return new RSVP.Promise(function(resolve, reject) {
      view.query(function(error, results) {
        if (error) {
          reject(error);
        } else {
          resolve(results);
        }
      });
    });
  };

  this.queryMultiGet = function(designDoc, viewName, args) {
    return this.queryView(designDoc, viewName, args).then(function(results) {
      var keys = results.map(function(item) {return item.id});
      if (keys.length) {
        return self.getMulti(keys);
      }
      return [];
    });
  }
}

module.exports = {
  connect: function(args) {
    return new RSVP.Promise(function(resolve, reject) {
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
