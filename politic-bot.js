var EventSource = require('eventsource'),
    couchbase   = require('couchbase'),
    request     = require('request'),
    RSVP        = require('rsvp'),
    subreddits  = [
      'Politics', 'WorldNews', 'Canada', 'CanadaPolitics', 'Communism', 'News',
      'Obama', 'evolutionReddit', 'Liberal', 'Progressive', 'Conservative',
      'conservatives', 'Democrats', 'Republican', 'Libertarian', 'LibertarianLeft',
      'ModeratePolitics', 'Anarchism', 'Bad_Cop_No_Donut', 'RonPaul', 'Conspiracy',
      'PoliticalDiscussion', 'PoliticalHumor', 'AnythingGoesNews',
      'AnythingGoesPolitics', 'Socialism', 'Wikileaks', 'WorldEvents', 'WorldPolitics',
      'SOPA', 'StateoftheUnion', 'USPolitics', 'UKPolitics', 'Anarcho_Capitalism',
      'Economy', 'Economics', 'DarkNetPlan', 'MensRights', 'WomensRights'
    ],
    lastRedditRequestTimeByUrl = {},
    lastRedditRequestTime,
    submissionEventSource;

// Main entry point
connectToCouchbase({bucket: 'reddit-submissions'}).then(function(cb) {
  try {
    persistIncommingSubmissions(cb, 'http://api.rednit.com/submission_stream?eventsource=true&subreddit=' + subreddits.join('+'));
    pollForRemovals(cb, true);
  } catch(error) {
    console.error('Bot error', error, error.stack);
  }
}, function(error) {
  console.error('Error connecting to couchbase', error);
});


// Helper functions

function pollForRemovals(cb, continuous) {
  var promise = RSVP.all(subreddits.map(function(subreddit) {
    return findRemovedPosts(cb, subreddit).then(function(results) {
      var keys = Object.keys(results);
      if (keys.length) {
        console.log('Detected removals:', keys.map(function(key) {
          return 'http://reddit.com' + results[key].value.permalink
        }));
      }
    }, function(err) {
      console.error('pollForRemovals', err);
      throw err;
    });
  }));

  if (continuous) {
    promise.then(function() {
      pollForRemovals(cb, continuous);
    }, function(err) {
      pollForRemovals(cb, continuous);
      console.error('pollForRemovals continuous', err);
    });
  }
  return promise;
}

function findRemovedNames(cb, subreddit) {
  return fetchSubredditListing(subreddit).then(function(results) {
    var listedIds = Object.keys(results).sort(),
        oldestId = listedIds[0];
    return recentIdsForSub(cb, subreddit, oldestId).then(function(recentIds) {
      recentIds = recentIds.sort().reverse();
      newestId = recentIds[0];
      return recentIds.filter(function(id) {
        return (id < newestId && listedIds.indexOf(id) == -1)
      });
    });
  }, function(err) {
    console.error('findRemovedNames', err, err.stack);
    throw err;
  });
}

function findRemovedPosts(cb, subreddit) {
  return findRemovedNames(cb, subreddit).then(function(names) {
    if (names && names.length) {
      return multiget(cb, names);
    }
    return [];
  }, function(err) {
    console.error('findRemovedPosts', err, err.stack);
    throw err;
  });
}

function connectToCouchbase(args) {
  return RSVP.Promise(function(resolve, reject) {
    var cb = new couchbase.Connection(args, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(cb);
      }
    });
  });
}

function persist(cb, key, value) {
  return RSVP.Promise(function(resolve, reject) {
    cb.set(key, value, function(error) {
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    });
  });
}

function multiget(cb, keys) {
  return RSVP.Promise(function(resolve, reject) {
    cb.getMulti(keys, null, function(error, results) {
      if (error) {
        reject(error);
      } else {
        resolve(results);
      }
    });
  });
}

function persistIncommingSubmissions(cb, url) {
  var eventSource = new EventSource(url);
  eventSource.onmessage = function(evt) {
    try {
      var data = JSON.parse(evt.data);
      persist(cb, data.name, data).then(function() {
        console.log('New submission: ', 'http://reddit.com' + data.permalink);
      }, function(err) {
        console.error('Error persisting', err);
      });
    } catch(error) {
      console.error(error, error.stack);
    }
  };
  eventSource.onerror = function(error) {
    console.error("Submission EventSource error", error);
  }
  return eventSource;
}

function recentIdsForSub(cb, subreddit, oldestId) {
  var query = cb.view('dev_reddit', 'recentIdsBySubreddit', {
        descending: true,
        startkey: [subreddit, {}],
        endkey: [subreddit, null]
      });

  return RSVP.Promise(function(resolve, reject) {
    query.query(function(err, values) {
      var results = [],
          reachedOldestId = false;
      if (err) {
        reject(err);
      } else {
        values.forEach(function(value) {
          if (!reachedOldestId) {
            results.push(value);
            if (oldestId && value.id === oldestId) {
              reachedOldestId = true;
            }
          }
        });
        resolve(results.map(function(item) {return item.id;}));
      }
    });
  });
}

function fetchSubredditListing(subreddit) {
  return RSVP.Promise(function(resolve, reject) {
    reddit_req('http://reddit.com/r/' + subreddit + '/new.json', {
      headers: {
        'User-Agent': 'politic-bot/0.2.0'
      }
    }, function(error, response, body) {
      if (error) {
        reject(error);
      } else {
        var listing = JSON.parse(body),
            results = {};
        if (listing && listing.data && listing.data.children && listing.data.children.length) {
          listing.data.children.forEach(function(submission) {
            results[submission.data.name] = submission.data;
          });
          resolve(results);
        } else {
          resolve([]);
        }
      }
    });
  });
}

function reddit_req(url) {
  try {
    var now = new Date(),
        args = arguments,
        minInterval = 2100,
        minUrlInterval = 30100,
        lastUrlInterval,
        lastUrlTime = lastRedditRequestTimeByUrl[url],
        interval = now - lastRedditRequestTime;
    if (lastUrlTime) {
      lastUrlInterval = now - lastUrlTime;
    }
    if (lastRedditRequestTime && interval < minInterval) {
      setTimeout(function() {
        reddit_req.apply(this, args);
      }, minInterval - interval + 100, arguments);
    } else {
      if (lastUrlInterval && lastUrlInterval < minUrlInterval) {
        setTimeout(function() {
          reddit_req.apply(this, args);
        }, minUrlInterval - lastUrlInterval + 100, arguments);
      } else {
        lastRedditRequestTime = now;
        lastRedditRequestTimeByUrl[url] = now;
        //console.log('requesting', url);
        request.apply(this, arguments);
      }
    }
  } catch(e) {
    console.error('reddit_req', e, e.stack);
  }
}
