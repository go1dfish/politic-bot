var request = require('request'),
    RSVP    = require('rsvp'),
    baseUrl = 'http://www.reddit.com',
    lastRedditRequestTimeByUrl = {},
    lastRedditRequestTime;

function Nodewhal(userAgent) {
  var self = this;
  if (!userAgent) {
    userAgent = 'noob-nodewhal-dev-soon-to-be-ip-banned';
  }

  self.listing = function(listingPath, max, after) {
    var url = baseUrl + listingPath + '.json',
        limit = max || 100;
    if (after) {
      url += '?limit=' + limit + '&after=' + after;
    }
    return self.get(url).then(function(body) {
      var listing = JSON.parse(body),
          results = {}, resultsLength;
      if (listing && listing.data && listing.data.children && listing.data.children.length) {
        listing.data.children.forEach(function(submission) {
          results[submission.data.name] = submission.data;
        });
        resultsLength = Object.keys(results).length;

        if (
          listing.data.after &&
          (typeof max === 'undefined' || resultsLength < max)
        ) {
          if (!typeof max === 'undefined') {
            max = max - resultsLength;
          }
          return self.listing(listingPath, max, listing.data.after).then(function(moreResults) {
            Object.keys(moreResults).forEach(function(key) {
              results[key] = moreResults[key];
            });
            return results;
          });
        } else {
          return results;
        }
      } else {
        return {};
      }
    });
  };

  self.get = function(url, opts) {
    return Nodewhal.respectRateLimits(url).then(function() {
      opts = opts || {};
      opts.headers = opts.headers || {};
      opts.headers['User-Agent'] = userAgent;
      return Nodewhal.promiseGetRequest(url, opts);
    });
  };
}

Nodewhal.promiseGetRequest = function(url, opts) {
  return new RSVP.Promise(function(resolve, reject) {
    console.log('requesting', url);
    request(url, opts, function(error, response, body) {
      if (error) {
        reject(error);
      } else {
        resolve(body);
      }
    });
  });
}

Nodewhal.respectRateLimits = function (url) {
  return new RSVP.Promise(function(resolve, reject) {
    var now = new Date(),
        minInterval = 2100,
        minUrlInterval = 30100,
        lastUrlInterval, lastUrlTime = lastRedditRequestTimeByUrl[url],
        interval = now - lastRedditRequestTime;

    if (lastUrlTime) {
      lastUrlInterval = now - lastUrlTime;
    }
    if (lastRedditRequestTime && interval < minInterval) {
      setTimeout(function() {
        resolve(Nodewhal.respectRateLimits(url));
      }, minInterval - interval + 100);
    } else {
      if (lastUrlInterval && lastUrlInterval < minUrlInterval) {
        setTimeout(function() {
          resolve(Nodewhal.respectRateLimits(url));
        }, minUrlInterval - lastUrlInterval + 100);
      } else {
        lastRedditRequestTime = now;
        lastRedditRequestTimeByUrl[url] = now;
        resolve(true);
      }
    }
  });
};

module.exports = Nodewhal;
