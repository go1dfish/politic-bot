var EventSource = require('eventsource'),
    couchbase   = require('./util/couchbase-rsvp'),
    redditReq   = require('./util/reddit-request'),
    request     = require('request'),
    RSVP        = require('rsvp'),
    config      = require('./config'),
    subreddits  = config.subreddits,
    continuousInterval = require('./util/continuous-interval'),
    submissionEventSource;

// Main entry point
couchbase.connect({bucket: 'reddit-submissions'}).then(function(cb) {
  try {
    persistIncommingSubmissions(cb, 'http://api.rednit.com/submission_stream?eventsource=true&subreddit=' + subreddits.join('+'));
    pollForRemovals(cb, 100);
  } catch(error) {
    console.error('Bot error', error, error.stack);
  }
}, function(error) {
  console.error('Error connecting to couchbase', error, error.stack);
  throw error;
});

// Tasks
function persistIncommingSubmissions(cb, url) {
  var eventSource = new EventSource(url);
  eventSource.onmessage = function(evt) {
    try {
      var data = JSON.parse(evt.data);
      cb.set(data.name, data).then(function() {
        console.log('New submission: ', 'http://reddit.com' + data.permalink);
      }, function(error) {
        console.error('Error persisting', error, error.stack);
        throw error;
      });
    } catch(error) {
      console.error(error, error.stack);
    }
  };
  eventSource.onerror = function(error) {
    console.error("Submission EventSource error", error, error.stack);
  }
  return eventSource;
}

function pollForRemovals(cb, interval) {
  return continuousInterval(function() {
    return RSVP.all(subreddits.map(function(subreddit) {
      return findRemovedSubmissions(cb, subreddit).then(function(results) {
        var keys = Object.keys(results);
        if (keys.length) {
          console.log('Detected removals:', keys.map(function(key) {
            return 'http://reddit.com' + results[key].value.permalink
          }));
        }
      }, function(error) {
        console.error('pollForRemovals', error, error.stack);
        throw error;
      });
    }));
  }, interval);
}

function pollForMirrors(cb, interval) {
  return continuousInterval(function() {
    return selectUnmirroredSubmissions(cb).then(function(unmirrored) {
      return mirrorSubmissions(cb, unmirrored);
    });
  }, interval);
}

function findRemovedNames(cb, subreddit) {
  return fetchSubredditListing(subreddit).then(function(results) {
    var listedIds = Object.keys(results).sort(),
        oldestId = listedIds[0];
    console.log(subreddit, 'listedIds', listedIds.length);
    return getRecentIdsForSubreddit(cb, subreddit, oldestId).then(function(recentIds) {
      recentIds = recentIds.sort().reverse();
      newestId = recentIds[0];
      return recentIds.filter(function(id) {
        return (id < newestId && listedIds.indexOf(id) == -1)
      });
    });
  }, function(error) {
    console.error('findRemovedNames', error, error.stack);
    throw error;
  });
}

function findRemovedSubmissions(cb, subreddit) {
  return findRemovedNames(cb, subreddit).then(function(names) {
    if (names && names.length) {
      return cb.getMulti(names);
    }
    return [];
  }, function(error) {
    console.error('findRemovedSubmissions', error, error.stack);
    throw error;
  });
}

function getRecentIdsForSubreddit(cb, subreddit, oldestId) {
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
}

function fetchSubredditListing(subreddit, after) {
  var url = 'http://reddit.com/r/' + subreddit + '/new.json?limit=100';
  if (after) {
    url += '&after=' + after;
  }
  return RSVP.Promise(function(resolve, reject) {
    redditReq(url, {
      headers: {'User-Agent': config.userAgent}
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

function selectUnmirroredSubmissions(cb) {
  return findUnmirrored(cb).then(function(unmirrored) {
    return fetchByRedditName(
      unmirrored.map(function(i) {return i.value;}).filter(function(item) {
        return !item.mirror_name;
      }).map(function(item) {return item.name})
    );
  });
}

function mirrorSubmissions(cb, submissions) {
  return RSVP.all(submissions.map(function(post) {
    return mirrorSubmission(cb, post, config.mirrorSubreddit);
  }));
}

function mirrorSubmission(cb, post, destination) {
  return cb.get(post.name).then(function(result) {
    var postData = result.value;
    if (postData.mirror_name) {
      throw "Already mirrored";
    }
    return cb.set(postData.name, postData).then(function() {
      return postData.mirror;
    });
  });
}

function findUnmirrored(cb) {
  return cb.queryMultiGet('reddit', 'submissionsByMirrorStateAndUrl', {
    startkey: [false, null],
    endkey:   [false, {}]
  });
}

function findUnreportedRemoved(cb) {
  return cb.queryMultiGet('reddit', 'submissionsByDisappearedAndReported', {
    startkey: [true, false, null],
    endkey:   [true, false, {}]
  });
}
