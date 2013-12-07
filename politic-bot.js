var EventSource = require('eventsource'),
    fs          = require('fs'),
    entities    = new (require('html-entities').AllHtmlEntities)();
    Nodewhal    = require('nodewhal'),
    Handlebars  = require('handlebars'),
    couchbase   = require('./util/couchbase-rsvp'),
    config      = require('./config'),
    RSVP        = require('rsvp'),
    subreddits  = config.subreddits,
    mirrors     = {},
    reporter    = Nodewhal(config.userAgent),
    mirrorer    = Nodewhal(config.userAgent),
    anonymous   = Nodewhal(config.userAgent),
    mirrorCommentTemplate = Handlebars.compile(
      fs.readFileSync('./templates/mirror-comment-template.hbs') + ''
    ),
    reportRemovalCommentTemplate = Handlebars.compile(
      fs.readFileSync('./templates/report-removal-comment-template.hbs') + ''
    ),
    mirrorRemovalCommentTemplate = Handlebars.compile(
      fs.readFileSync('./templates/mirror-removal-comment-template.hbs') + ''
    ),
    taskInterval = 50;

// Main entry point
couchbase.connect({bucket: 'reddit-submissions'}).then(function(cb) {
  persistIncommingSubmissions(cb, subreddits);

  mirrorer.login(
    config.mirrorAccount.user, config.mirrorAccount.password
  ).then(function(mirrorer) {
    pollForMirrors(cb, taskInterval);
  });

  reporter.login(
    config.reportAccount.user, config.reportAccount.password
  ).then(function(reporter) {
    // Shalow poll only 1 page per subreddit for recent removals
    pollForRemovals(cb, taskInterval, 100);
    // Deep poll up to 1000 submissions per subreddit for older removals
    pollForRemovals(cb, taskInterval*100);
    // Periodically report removed submissions
    pollForReports(cb, taskInterval);
  });
}, function(error) {
  console.error('Error connecting to couchbase', error, error.stack);
  throw error;
});

// Tasks
function persistIncommingSubmissions(cb, subreddits) {
  console.log('Listening for new submissions', subreddits.join(','));
  return anonymous.startSubmissionStream(function(submission) {
    cb.set(submission.name, submission).then(function() {
      console.log('incomming:', 'http://www.reddit.com' + submission.permalink);
    }, function(error) {
      console.error('Error persisting', error.stack || error);
      throw error;
    });
  }, subreddits);
}

function pollForRemovals(cb, interval, depth) {
  return Nodewhal.schedule.repeat(function() {
    return Nodewhal.schedule.runInSeries(shuffle(subreddits.slice(0)).map(function(subreddit) {
      return function() {
        return pollRemovalsForSubreddit(cb, subreddit, interval, depth);
      };
    }), interval);
  }, interval);
}

function pollForMirrors(cb, interval) {
  return Nodewhal.schedule.repeat(function() {
    return selectUnmirroredSubmissions(cb).then(function(unmirrored) {
      return mirrorSubmissions(cb, unmirrored, interval);
    });
  }, interval);
}

function pollForReports(cb, interval) {
  return Nodewhal.schedule.repeat(function() {
    return findUnreportedRemoved(cb).then(function(unreported) {
      return Nodewhal.schedule.runInSeries(Object.keys(unreported).map(function(key) {
        return function() {
          return reportRemoval(cb, unreported[key].value, config.reportSubreddit);
        };
      }), interval);
    });
  }, interval);
}

function pollRemovalsForSubreddit(cb, subreddit, interval, depth) {
  return findRemovedSubmissions(cb, subreddit, interval, depth).then(function(results) {
    var keys = Object.keys(results);
    if (keys.length) {
      var removals = {};
      keys.forEach(function(key) {
        var submission = results[key].value;
        if (!submission.disappeared) {
          removals[key] = submission;
          removals[key].disappeared = new Date().getTime() / 1000;
          console.log('disappeared', 'http://www.reddit.com/' + removals[key].permalink);
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

function findRemovedNames(cb, subreddit, interval, depth) {
  return anonymous.listing('/r/' + subreddit + '/new', {
    wait: interval,
    max: depth
  }).then(function(results) {
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

function findRemovedSubmissions(cb, subreddit, interval, depth) {
  return findRemovedNames(cb, subreddit, interval, depth).then(function(names) {
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
      return (!item.mirror_name && (config.filterDomains.indexOf(item.domain) === -1));
    });
  });
}

function mirrorSubmissions(cb, submissions, interval) {
  return Nodewhal.schedule.runInSeries(submissions.map(function(post) {
    return function() {
      return mirrorSubmission(cb, post, config.mirrorSubreddit);
    };
  }), interval);
}

function mirrorSubmission(cb, post, dest) {
  return cb.get(post.name).then(function(result) {
    var postData = result.value;
    if (!postData || postData.mirror_name) {
      return {};
    }
    if (mirrors[postData.url]) {
      postData.mirror_name = mirrors[postData.url];
      return cb.set(postData.name, postData).then(function() {
        return cb.get(postData.mirror_name).then(function(data) {
          console.log('Used cached mirror', data.value.name);
          return data.value;
        });
      });
    }
    if (post && post.author === '[deleted]') {
      post.mirror_name = '[deleted]'
      console.log('deleted post not mirroring');
      return cb.set(post.name, post)
    }
    if (post && post.subreddit === dest) {
      post.mirror_name = post.name
      console.log('mirror post not mirroring');
      return cb.set(post.name, post)
    }
    if (post && post.subreddit === config.reportSubreddit) {
      post.mirror_name = post.name
      console.log('report post not mirroring');
      return cb.set(post.name, post)
    }
    return mirrorer.submitted(dest, postData.url).then(function(submitted) {
      if (typeof submitted === 'object') {
        var mirror = submitted[0].data.children[0].data;
        postData.mirror_name = mirror.name;

        cb.set(mirror.name, mirror);
        return cb.set(postData.name, postData).then(function() {
          mirrors[postData.url] = mirror.name;
          console.log('already submitted', postData.url, mirror.permalink);
          return mirror;
        });
      } else {
        return mirrorer.checkForShadowban(postData.author).then(function() {
          return mirrorer.submit(dest, 'link',
            entities.decode(postData.title), postData.url
          ).then(function(mirror) {
            mirrors[postData.url] = mirror.name;
            postData.mirror_name = mirror.name;
            cb.set(mirror.name, mirror);
            return cb.set(postData.name, postData).then(function() {
              return RSVP.all([
                mirrorer.comment(mirror.name,
                  mirrorCommentTemplate({
                    post: postData,
                    mirror: mirror
                  })
                ),
                mirrorer.flair(dest, mirror.name, 'meta',
                  postData.subreddit + '|' + postData.author
                )
              ]).then(function() {return mirror;});
            });
          });
        }, function(error) {
          if (error === 'shadowban') {
            console.log(postData.author, error);
            postData.mirror_name = 'shadowbanned';
            cb.set(postData.name, postData);
          } else {
            console.error(post.author, error, error.stack);
          }
          throw error;
        });
      }
    });
  });
}

function reportRemoval(cb, post, dest) {
  var url = "http://www.reddit.com" + post.permalink;

  function flairReport(report) {
    return reporter.flair(dest, report.name, 'removed',
      post.subreddit + '|' + post.author
    ).then(function() {
      console.log('reported to', report.url)
      return report;
    });
  }

  return reporter.byId(post.name).then(function(updatedPost) {
    if (updatedPost.author === '[deleted]') {
      post.report_name = '[deleted]'
      console.log('deleted post not reporting');
      return cb.set(post.name, post)
    }
    if (post.mirror_name && post.mirror_name !== 'shadowbanned' && post.mirror_name !== '[deleted]') {
      mirrorer.duplicates(config.mirrorSubreddit, post.mirror_name).then(function(duplicates) {
        var dupes = [], listed;
        try {
          duplicates.forEach(function(listing) {
            if (listing && listing.data && listing.data.children) {
              listing.data.children.forEach(function(child) {
                dupes.push(child.data);
              });
            }
          });
          listed = dupes.forEach(function(dupe) {
            if (
              dupe.subreddit === post.subreddit
              && dupe.url === post.url
            ) {
              listed = dupe;
            };
          });
        } catch(e) {
          console.error(e.stack);
          throw e;
        }

        if (listed) {
          console.error('listed', listed);
          post.disappeared = null;
          return cb.set(post.name, post).then(function() {return {}});
        } else {
          try {
            if (updatedPost.selftext_html && updatedPost.selftext_html.indexOf('[removed]') === -1) {
              console.error('self text not removed', updatedPost);
              post.disappeared = null;
              return cb.set(post.name, post).then(function() {return {}});
            }
          } catch(e) {console.error(e.stack)}
          return reporter.checkForShadowban(post.author).then(function() {
            return reporter.submitted(dest, url).then(function(submitted) {
              if (typeof submitted === 'object') {
                var report = submitted[0].data.children[0].data;
                post.report_name = report.name;
                cb.set(report.name, report);
                return cb.set(post.name, post).then(function() {
                  return report;
                });
              } else {
                return reporter.submit(dest, 'link',
                  entities.decode(post.title), url
                ).then(function(report) {
                  post.report_name = report.name;
                  cb.set(report.name, report);
                  return cb.set(post.name, post).then(function() {
                    return mirrorer.byId(post.mirror_name).then(function(mirror) {
                      return RSVP.all([
                        mirrorer.flair(mirror.subreddit, mirror.name, 'removed',
                          (mirror.link_flair_text)
                        ),
                        reporter.comment(mirror.name,
                          '[Removed from /r/'+post.subreddit+'](' + report.url+')'
                        ),
                        reporter.comment(report.name,
                          reportRemovalCommentTemplate({
                            post:   updatedPost,
                            report: report,
                            mirror: mirror
                          })
                        ),
                      ]).then(function() {return flairReport(report);});
                    });
                  });
                });
              }
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
          });
        }
      });
    } else {
      return {};
    }
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
