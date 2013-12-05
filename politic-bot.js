var EventSource = require('eventsource'),
    entities    = new (require('html-entities').AllHtmlEntities)();
    Nodewhal    = require('nodewhal'),
    couchbase   = require('./util/couchbase-rsvp'),
    config      = require('./config'),
    subreddits  = config.subreddits,
    reddit      = new Nodewhal(config.userAgent);

// Main entry point
couchbase.connect({bucket: 'reddit-submissions'}).then(function(cb) {
  try {
    persistIncommingSubmissions(cb, 'http://api.rednit.com/submission_stream?eventsource=true&subreddit=' + subreddits.join('+'));
    reddit.login(config.mirrorAccount.user, config.mirrorAccount.password).then(function(session) {
      pollForMirrors(cb, session, 100);
    });
    reddit.login(config.reportAccount.user, config.reportAccount.password).then(function(session) {
      pollForRemovals(cb, session, 100);
      pollForReports(cb, session, 100);
    });
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
        console.log('incomming:', 'http://www.reddit.com' + data.permalink);
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
  console.log('Listening for new submissions on', url);
  return eventSource;
}

function pollForRemovals(cb, session, interval) {
  return Nodewhal.schedule.repeat(function() {
    return Nodewhal.schedule.runInSerial(shuffle(subreddits.slice(0)).map(function(subreddit) {
      return function() {
        return pollRemovalsForSubreddit(cb, session, subreddit, interval);
      };
    }), interval);
  }, interval);
}

function pollForMirrors(cb, session, interval) {
  return Nodewhal.schedule.repeat(function() {
    return selectUnmirroredSubmissions(cb).then(function(unmirrored) {
      return mirrorSubmissions(cb, session, unmirrored, interval);
    });
  }, interval);
}

function pollForReports(cb, session, interval) {
  return Nodewhal.schedule.repeat(function() {
    return findUnreportedRemoved(cb).then(function(unreported) {
      return Nodewhal.schedule.runInSerial(Object.keys(unreported).map(function(key) {
        return function() {
          return reportRemoval(cb, session, unreported[key].value, config.reportSubreddit);
        };
      }), interval);
    });
  }, interval);
}

function pollRemovalsForSubreddit(cb, session, subreddit, interval) {
  return findRemovedSubmissions(cb, subreddit, interval).then(function(results) {
    var keys = Object.keys(results);
    if (keys.length) {
      var removals = {};
      keys.forEach(function(key) {
        var submission = results[key].value;
        if (!submission.disappeared) {
          removals[key] = submission;
          removals[key].disappeared = new Date().getTime() / 1000;
        }
      });
      if (Object.keys(removals).length) {
        return cb.setMulti(removals).then(function() {
          return removals;
        });
      }
    }
    return {};
  });
}

function findRemovedNames(cb, subreddit, interval) {
  return reddit.listing(null, '/r/' + subreddit + '/new', {wait: interval}).then(function(results) {
    var listedIds = Object.keys(results).sort(),
        oldestId = listedIds[0];
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

function findRemovedSubmissions(cb, subreddit, interval) {
  return findRemovedNames(cb, subreddit, interval).then(function(names) {
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

function selectUnmirroredSubmissions(cb) {
  return findUnmirrored(cb).then(function(unmirrored) {
    return Object.keys(unmirrored).map(
      function(key) {return unmirrored[key].value;}
    ).filter(function(item) {;
      return !item.mirror_name && (config.filterDomains.indexOf(item.domain) === -1);
    });
    /*
    return reddit.byName(null,
      // TODO: Sort/filter to find best posts to mirror
      return Object.keys(unmirrored).map(function(key) {return unmirrored[key];}).map(
        function(i) {return i.value;}).filter(function(item) {
          return !item.mirror_name;
        }
      ).map(function(item) {return item.name})
    );
    */
  });
}

function mirrorSubmissions(cb, session, submissions, interval) {
  return Nodewhal.schedule.runInSerial(submissions.map(function(post) {
    return function() {
      return mirrorSubmission(cb, session, post, config.mirrorSubreddit);
    };
  }), interval);
}

function mirrorSubmission(cb, session, post, dest) {
  return cb.get(post.name).then(function(result) {
    var postData = result.value;
    if (postData.mirror_name) {
      return {};
    }
    reddit.checkForShadowban(post.author).then(function() {
      return reddit.submitted(session, dest, postData.url).then(function(submitted) {
          console.log(JSON.stringify(submitted));
        if (submitted[0].data) {
          try {
          postData.mirror_name = submitted[0].data.children[0].name;
          return cb.set(postData.name, postData).then(function() {
            console.log('already submitted', postData.url);
            return {};
          })
          } catch(e) {console.log(e.stack)}
        } else {
          return reddit.submit(session, dest, 'link',
            entities.decode(postData.title), postData.url
          ).then(function(mirror) {
            postData.mirror_name = mirror.name;
            return cb.set(postData.name, postData).then(function() {
              return reddit.flair(session, dest, mirror.name, 'meta',
                postData.subreddit + '|' + postData.author
              ).then(function() {
                console.log('mirrored to', mirror.url)
                return mirror;
              });
            });
          });
        }
      });
    }, function(error) {
      if (error === 'shadowban') {
        console.log(post.author, error);
        post.mirror_name = 'shadowbanned';
        return cb.set(post.name, post);
      } else {
        console.error(post.author, error, error.stack);
      }
      throw error;
    });
  });
}

function reportRemoval(cb, session, post, destination) {
  return reddit.checkForShadowban(post.author).then(function() {
    return reddit.submit(session, destination, 'link',
      entities.decode(post.title), 'http://reddit.com' + post.permalink
    ).then(function(report) {
      post.report_name = report.name;
      return cb.set(post.name, post).then(function() {
        return reddit.flair(session, destination, report.name, 'removed',
          post.subreddit + '|' + post.author
        ).then(function() {
          console.log('reported to', report.url)
          return report;
        });
      });
    }, function(error) {
      if (error[0][0] === 'ALREADY_SUB') {
        postData.mirror_name = true;
        return cb.set(postData.name, postData).then(function() {
          return {};
        })
      } else {
        console.error(reportRemoval, error, error.stack);
        throw error;
      }
    });
  }, function(error) {
    if (error === 'shadowban') {
      console.log(post.author, error);
      post.report_name = 'shadowbanned';
      return cb.set(post.name, post);
    } else {
      console.error(error, error.stack);
    }
    throw error;
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
    startkey: [true, false],
    endkey:   [true, false]
  });
}

//+ Jonas Raoni Soares Silva
//@ http://jsfromhell.com/array/shuffle [v1.0]
function shuffle(o){ //v1.0
    for(var j, x, i = o.length; i; j = Math.floor(Math.random() * i), x = o[--i], o[i] = o[j], o[j] = x);
    return o;
};
