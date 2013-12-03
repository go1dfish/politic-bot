var EventSource = require('eventsource'),
    couchbase   = require('./couchbase-rsvp'),
    request     = require('request'),
    RSVP        = require('rsvp'),
    subreddits  = [
      'politics', 'worldnews', 'Canada', 'CanadaPolitics', 'Communism', 'News',
      'Obama', 'evolutionReddit', 'Liberal', 'Progressive', 'Conservative',
      'conservatives', 'Democrats', 'Republican', 'Libertarian', 'LibertarianLeft',
      'ModeratePolitics', 'Anarchism', 'Bad_Cop_No_Donut', 'RonPaul', 'Conspiracy',
      'PoliticalDiscussion', 'PoliticalHumor', 'AnythingGoesNews',
      'AnythingGoesPolitics', 'Socialism', 'Wikileaks', 'WorldEvents', 'WorldPolitics',
      'SOPA', 'StateoftheUnion', 'USPolitics', 'UKPolitics', 'Anarcho_Capitalism',
      'Economy', 'Economics', 'DarkNetPlan', 'MensRights', 'WomensRights'
    ],
    subreddits = ['worldnews'],
    USER_AGENT = 'politic-bot/0.2.0',
    MIRROR_SUBREDDIT = 'POLITIC',
    REPORT_SUBREDDIT = 'ModerationLog',
    lastRedditRequestTimeByUrl = {},
    lastRedditRequestTime,
    submissionEventSource;

// Main entry point
couchbase.connect({bucket: 'reddit-submissions'}).then(function(cb) {
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

function persistIncommingSubmissions(cb, url) {
  var eventSource = new EventSource(url);
  eventSource.onmessage = function(evt) {
    try {
      var data = JSON.parse(evt.data);
      cb.set(data.name, data).then(function() {
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
      console.error('pollForRemovals continuous', err, err.stack);
    });
  }
  return promise;
}

function findRemovedNames(cb, subreddit) {
  return fetchSubredditListing(subreddit).then(function(results) {
    var listedIds = Object.keys(results).sort(),
        oldestId = listedIds[0];
    console.log('listedIds', listedIds.length);
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
      return cb.getMulti(names);
    }
    return [];
  }, function(err) {
    console.error('findRemovedPosts', err, err.stack);
    throw err;
  });
}

function recentIdsForSub(cb, subreddit, oldestId) {
  return cb.queryView('reddit', 'recentIdsBySubreddit', {
    descending: true,
    startkey: [subreddit, {}],
    endkey: [subreddit, null]
  }).then(function(values) {
    var results = [],
        reachedOldestId = false;
    values.forEach(function(value) {
      if (!reachedOldestId) {
        results.push(value);
        if (oldestId && value.id === oldestId) {
          reachedOldestId = true;
        }
      }
    });
    return results.map(function(item) {return item.id;});
  });

  return RSVP.Promise(function(resolve, reject) {
    view.query(function(err, values) {
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

function fetchSubredditListing(subreddit, after) {
  var url = 'http://reddit.com/r/' + subreddit + '/new.json?limit=100';
  if (after) {
    url += '&after=' + after;
  }
  return RSVP.Promise(function(resolve, reject) {
    redditReq(url, {
      headers: {
        'User-Agent': USER_AGENT
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
          if (listing.data.after) {
            fetchSubredditListing(subreddit, listing.data.after).then(function(moreResults) {
              Object.keys(moreResults).forEach(function(key) {
                results[key] = moreResults[key];
              });
              resolve(results);
            }, function(error) {reject(error);});
          } else {
            resolve(results);
          }
        } else {
          resolve({});
        }
      }
    });
  });
}

function mirrorPosts(cb, continuous) {
  var promise = findUnmirroredPosts(cb).then(function(unmirrored) {
    return RSVP.all(unmirrored.map(function(post) {
      return mirrorPost(cb, post, MIRROR_SUBREDDIT);
    }));
  });
  if (continuous) {
    promise.then(function() {
      mirrorPosts(cb, continuous);
    }, function(err) {
      console.error('mirrorPosts', err, err.stack);
      mirrorPosts(cb, continuous);
    });
  }
  return promise;
}

function mirrorPost(cb, post, destination) {
  return cb.get(post.name).then(function(result) {
    var postData = result.value;
    if (postData.mirror) {
      throw "Already mirrored";
    }
    return cb.set(postData.name, postData).then(function() {
      return postData.mirror;
    });
  });
}

function findUnmirroredPosts(cb) {
  var view = cb.view('reddit', 'unmirroredPosts', {
        descending: true,
        startkey: [subreddit, {}],
        endkey: [subreddit, null]
      });
}

function redditReq(url) {
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
        redditReq.apply(this, args);
      }, minInterval - interval + 100, arguments);
    } else {
      if (lastUrlInterval && lastUrlInterval < minUrlInterval) {
        setTimeout(function() {
          redditReq.apply(this, args);
        }, minUrlInterval - lastUrlInterval + 100, arguments);
      } else {
        lastRedditRequestTime = now;
        lastRedditRequestTimeByUrl[url] = now;
        //console.log('requesting', url);
        request.apply(this, arguments);
      }
    }
  } catch(e) {
    console.error('redditReq', e, e.stack);
  }
}
