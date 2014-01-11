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
    tempFail = {},
    additionalMirrors = config.additionalMirrors,
    mirrorCommentTemplate = Handlebars.compile(
      fs.readFileSync('./templates/mirror-comment-template.hbs') + ''
    ),
    reportRemovalCommentTemplate = Handlebars.compile(
      fs.readFileSync('./templates/report-removal-comment-template.hbs') + ''
    ),
    mirrorRemovalCommentTemplate = Handlebars.compile(
      fs.readFileSync('./templates/mirror-removal-comment-template.hbs') + ''
    ),
    taskInterval = 2000;

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
    pollForRemovals(cb, taskInterval*10, 100);
    // Deep poll up to 1000 submissions per subreddit for older removals
    pollForRemovals(cb, taskInterval*30);
    // Periodically report removed submissions
    pollForReports(cb, taskInterval);
    // Poll top 100 posts of mirror subreddit looking at other discussions tab
    pollMirrorsForRemovals(cb, taskInterval*15, 100);
  });
}, function(error) {
  console.error('Error connecting to couchbase', error, error.stack);
  throw error;
});

// Tasks
function persistIncommingSubmissions(cb, subreddits) {
  return anonymous.startSubmissionStream(function(submission) {
    cb.set(submission.name, submission).then(function() {
      console.log('new:', 'http://www.reddit.com' + submission.permalink);
      mirrorSubmissions(cb, [submission]);
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

function pollMirrorsForRemovals(cb, interval, depth) {
  // Experimental
  return Nodewhal.schedule.repeat(function() {
    return anonymous.listing('/r/' + config.mirrorSubreddit, {
      wait: interval,
      max: depth
    }).then(function(mirrored) {
      mirrored = Object.keys(mirrored).map(function(key) {return mirrored[key];});
      return Nodewhal.schedule.runInSeries(shuffle(mirrored.filter(function(mirror) {
        return isValidMirror(mirror);
      }).map(function(mirror) {
        return function() {
          return checkMirrorForRemoval(cb, mirror, interval);
        }
      })), interval);
    });
  }, interval);
}

function pollForReports(cb, interval) {
  return Nodewhal.schedule.repeat(function() {
    return findUnreportedRemoved(cb).then(function(unreported) {
      return Nodewhal.schedule.runInSeries(shuffle(Object.keys(unreported).map(function(key) {
        return unreported[key].value;
      }).filter(function(post) {
        return isValidPost(post) && post.mirror_name && !post.report_name;
      }).map(function(post) {
        return function() {
          return cb.get(post.mirror_name).then(function(mirror) {
            if (tempFail[mirror.name]) {
              return Nodewhal.schedule.wait();
            }
            return checkMirrorForRemoval(cb, mirror.value, interval, post);
          });
        };
      })), interval);
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
  return Nodewhal.schedule.runInSeries(shuffle(submissions.map(function(post) {
    return function() {
      if (tempFail[post.name]) {
        return Nodewhal.schedule.wait();
      }
      if (post.author === '[deleted]') {
        post.mirror_name = '[deleted]';
        return cb.set(post.name, post).then(function() {return {};});
      }
      if (!isValidPost(post)) {
        post.mirror_name = post.name
        return cb.set(post.name, post)
      }
      return anonymous.aboutUser(post.author).then(function(author) {
        var authorAge = post.created_utc - author.created_utc;
        if (authorAge < config.minAuthorAge) {
          post.mirror_name = 'authoryoung';
          return cb.set(post.name, post).then(function() {return {};});
        }
        return mirrorSubmission(
          cb, post, config.mirrorSubreddit
        ).then(function(mirror) {
          return checkMirrorForRemoval(cb, mirror, interval, post).then(function() {
            return mirror;
          });
        }, function(error) {
          tempFail[post.name] = post;
          throw error;
        });
      });
    };
  })), interval);
}

function mirrorSubmission(cb, postData, dest) {
  return cb.get(postData.name).then(function(post) {
    if (post.value) {
      post = post.value;
    }
    if (!post || post.mirror_name) {
      return {};
    }
    if (mirrors[post.url]) {
      post.mirror_name = mirrors[post.url];
      return cb.set(post.name, post).then(function() {
        return cb.get(post.mirror_name).then(function(data) {
          return data.value;
        });
      });
    }
    var promise = mirrorer.submitted(dest, post.url).then(function(submitted) {
      if (typeof submitted === 'object') {
        var mirrorPost = submitted[0].data.children[0].data;
        post.mirror_name = mirrorPost.name;

        return mirrorer.byId(mirrorPost.name).then(function(mirror) {
          return cb.set(mirror.name, mirror).then(function() {
            return cb.set(post.name, post).then(function() {
              mirrors[post.url] = mirror.name;
              return mirror;
            });
          });
        });
      } else {
        return mirrorer.checkForShadowban(post.author).then(function() {
          var title = post.title,
              url = post.url;
          try {
            title = entities.decode(title);
            url = entities.decode(url);
          } catch(e) {
            console.error('Error encoding title:', post, e);
          }
          return mirrorer.byId(post.name).then(function(post) {
            if (post.author === '[deleted]') {
              post.mirror_name = '[deleted]';
              return cb.set(post.name, post).then(function() {return null});
            } else {
              return mirrorer.submit(dest, 'link',
                title, url
              ).then(function(mirrorPost) {
                return mirrorer.byId(mirrorPost.name).then(function(mirror) {
                  mirrors[post.url] = mirror.name;
                  post.mirror_name = mirror.name;
                  return cb.set(mirror.name, mirror).then(function() {
                    return cb.set(post.name, post).then(function() {
                      return RSVP.all([
                        mirrorer.flair(dest, mirror.name, 'meta',
                          post.subreddit + '|' + post.author
                        ),
                        mirrorer.comment(mirror.name,
                          mirrorCommentTemplate({
                            post: post,
                            mirror: mirror
                          })
                        )
                      ]).then(function() {return mirror;});
                    });
                  });
                });
              });
            }
          });
        }, function(error) {
          if (error === 'shadowban') {
            console.log(post.author, error);
            post.mirror_name = 'shadowbanned';
            cb.set(post.name, post);
          } else {
            console.error(post.author, error, error.stack);
          }
          throw error;
        });
      }
    });
    if (additionalMirrors[post.subreddit]) {
      var title = post.title,
          url = post.url;
      try {
        title = entities.decode(title);
        url = entities.decode(url);
      } catch(e) {
        console.error('Error encoding title:', post, e);
      }
      mirrorer.submit(additionalMirrors[post.subreddit], 'link',
        title, url
      );
    }
    return promise;
  });
}

function checkMirrorForRemoval(cb, mirror, interval, post) {
  if (tempFail[mirror.name]) {
    return Nodewhal.schedule.wait();
  }
  if (!isValidMirror(mirror)) {
    return Nodewhal.schedule.wait();
  }
  return findMirroredForUrl(cb, mirror.url).then(function(knownPosts) {
    var knownSubs = [],
        removedSubs = [],
        posts = {};
    if (post) {
      knownPosts.push(post);
    }
    knownPosts.forEach(function(known) {
      if (knownSubs.indexOf(known.subreddit) < 0 && isValidPost(known)) {
        knownSubs.push(known.subreddit);
        posts[known.subreddit] = known;
      }
    });
    if (!knownSubs.length) {
      console.error('No known posts for', mirror.permalink);
      return Nodewhal.schedule.wait();
    }
    return anonymous.duplicates(
      config.mirrorSubreddit, mirror.name
    ).then(function(duplicates) {
      var dupes = [];
      duplicates.forEach(function(listing) {
        if (listing && listing.data && listing.data.children) {
          listing.data.children.forEach(function(child) {
            if (isValidPost(child.data)) {
              dupes.push(child.data);
            }
          });
        }
      });
      knownSubs.forEach(function(sub) {
        var posts = dupes.filter(function(dupe) {return dupe.subreddit === sub;});
        if (posts.length === 0) {
          removedSubs.push(sub);
        }
      });
      if (mirror.url.indexOf('reddit.com/') >= 0) {
        // reportRemoval will determine if self post is removed
        return Nodewhal.schedule.runInSeries(removedSubs.map(function(sub) {
          var post = posts[sub];
          return function() {
            return reportRemoval(cb, post, config.reportSubreddit);
          };
        }));
      }
      if (removedSubs.length) {

        return Nodewhal.schedule.runInSeries(shuffle(removedSubs.map(function(sub) {
          var post = posts[sub];
          post.mirror_name = mirror.name
          return post;
        }).filter(function(post) {
          return isValidPost(post) && !post.report_name;
        }).map(function(post) {
          return function() {
            return anonymous.duplicates(
              post.subreddit, post.name
            ).then(function(postDuplicates) {
              if (postDuplicates.length && postDuplicates.length > 1) {
                return reportRemoval(cb, post, config.reportSubreddit);
              } else {
                console.error('post without dupes', post, postDuplicates);
                return Nodewhal.schedule.wait();
              }
            });
          };
        })), interval);
      }
    });
  }, function(error) {
    tempFail[mirror.name] = mirror;
    console.error('checkMirrorForRemoval', error.stack || error);
    throw error;
  });
}

function reportRemoval(cb, post, dest) {
  var url = "http://www.reddit.com" + post.permalink;

  if (!post.mirror_name || !isValidPost(post) || post.report_name) {
    return Nodewhal.schedule.wait();
  }

  return reporter.byId(post.name).then(function(updatedPost) {
    function flairReport(report) {
      var flairClass = 'removed';
      if (updatedPost.link_flair_text) {
        flairClass='flairedremoval';
      }
      return reporter.flair(dest, report.name, flairClass,
        post.subreddit + '|' + post.author
      ).then(function() {
        return report;
      });
    }

    if (updatedPost.author === '[deleted]') {
      post.report_name = '[deleted]'
      return cb.set(post.name, post);
    }
    try {
      if (  updatedPost.domain === ('self.' + post.subreddit)
            && updatedPost.selftext_html.indexOf('[removed]') === -1
      ) {
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
                    mirrorRemovalCommentTemplate({
                      post:   updatedPost,
                      report: report,
                      mirror: mirror
                    })
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
  });
}

function findUnmirrored(cb) {
  return cb.queryMultiGet('reddit', 'submissionsByMirrorStateAndUrl', {
    startkey: [false, null],
    endkey:   [false, {}]
  });
}

function findMirroredForUrl(cb, url) {
  return cb.queryMultiGet('reddit', 'submissionsByMirrorStateAndUrl', {
    startkey: [false, url],
    endkey:   [true, url]
  }).then(function(values) {
    return Object.keys(values).map(function(key) {
      return values[key].value;
    }).filter(function(post) {
      return post.url === url;
    });
  });
}

function findUnreportedRemoved(cb) {
  return cb.queryMultiGet('reddit', 'submissionsByDisappearedAndReported', {
    startkey: [true, false],
    endkey:   [true, false]
  });
}

function isValidMirror(post) {
  if (post.mirror_name === 'shadowbanned' || post.mirror_name === '[deleted]' || post.mirror_name === 'authoryoung' || post.subreddit === config.reportSubreddit) {
    return false;
  }
  return !!post.url;
}
function isValidPost(post) {
  if (post.mirror_name === 'shadowbanned' || post.mirror_name === '[deleted]' || post.mirror_name === 'authoryoung' || post.subreddit === config.mirrorSubreddit || post.subreddit === config.reportSubreddit) {
    return false;
  }
  return !!post.url;
}

//+ Jonas Raoni Soares Silva
//@ http://jsfromhell.com/array/shuffle [v1.0]
function shuffle(o){ //v1.0
    for(var j, x, i = o.length; i; j = Math.floor(Math.random() * i), x = o[--i], o[i] = o[j], o[j] = x);
    return o;
};
