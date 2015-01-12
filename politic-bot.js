var _ = require('underscore');
var fs = require('fs');
var entities = new (require('html-entities').AllHtmlEntities)();
var Handlebars  = require('handlebars');
var Nodewhal = require('nodewhal');
var config = require('./config');
var RSVP = require('rsvp');
var bot = Nodewhal(config.userAgent);
var anon = Nodewhal(config.userAgent);
var handledMentions = {};
var templates = {
  mirror: Handlebars.compile(fs.readFileSync('./templates/mirror-comment-template.hbs')+''),
  reportRemoval: Handlebars.compile(fs.readFileSync('./templates/report-removal-comment-template.hbs')+''),
  mirrorRemoval: Handlebars.compile(fs.readFileSync('./templates/mirror-removal-comment-template.hbs')+'')
};

if (config.streamUrl) {anon.streamUrl = config.streamUrl;} else {
  anon.streamUrl = "http://localhost:4243/submission_stream?eventsource=true";
  require('reddit-stream');
}

bot.login(config.user, config.password).then(function() {
  return RSVP.all([
    mirrorIncommingSubmissions(),
    pollMirrorsForRemovals(50),
    pollMirrorsForRemovals(500),
    checkMentions()
  ]);
}).then(undefined, function(error) {console.error("Err", error);});


var submissionQueue = [];


function mirrorIncommingSubmissions() {
  bot.get(bot.baseUrl + '/api/multi/mine').then(function(data) {
    return data.map(function(i) {return i.data;}).filter(function(item) {
      return item.name === 'monitored';
    })[0].subreddits.map(function(sub) {return sub.name;});
  }).then(function(subreddits) {
    return RSVP.all([
      anon.startSubmissionStream(function(post) {
        submissionQueue.splice(0, 0, post);
      }, subreddits),
      Nodewhal.schedule.repeat(function() {return mirrorSubmission(submissionQueue.pop());}, 100)
    ]);
  });
}

function mirrorSubmission(post) {
  if (post && post.author !== '[deleted]') {
    return anon.aboutUser(post.author).then(function(author) {
      var authorAge = post.created_utc - author.created_utc;
      if (authorAge < config.minAuthorAge) {return;}
      return bot.submitted(config.mirrorSubreddit, entities.decode(post.url)).then(function(submitted) {
        if (typeof submitted === 'object') {// Already mirrored/posted
          return bot.byId(submitted[0].data.children[0].data.name);
        } else {
          return bot.submit(config.mirrorSubreddit, 'link',
            entities.decode(post.title), entities.decode(post.url)
          ).then(function(mirror) {
            return bot.flair(config.mirrorSubreddit, mirror.name, 'meta',
                post.subreddit + '|' + post.author).then(function() {return bot.byId(mirror.name);});
          });
        }
      }).then(function(mirror) {
        return bot.comment(mirror.name, templates.mirror({
          post: post, mirror: mirror
        })).then(function() {return checkForRemovals(mirror);});
      });
    }).then(undefined, function(error) {
      if (error === 'usermissing') {return;} else {
        console.error('Mirroring error', error.stack || error);
      }
    });
  } else {
    return RSVP.resolve(null);
  }
}

function pollMirrorsForRemovals(depth, interval) {
  depth = depth || 500; interval = interval || 10000;
  return Nodewhal.schedule.repeat(function() {
    return anon.listing('/r/'+config.mirrorSubreddit, {max: depth, wait: interval}).then(function(mirrored) {
      mirrored = _.shuffle(Object.keys(mirrored).map(function(key) {return mirrored[key];}));
      return Nodewhal.schedule.runInSeries(mirrored.map(function(mirror) {
        return function() {return checkForRemovals(mirror);};
      }), interval);
    });
  }, interval);
}

function checkForRemovals(mirror, interval) {
  var mirrorReg = /\[Original Submission.*\]\((.*)\)/;
  var reportReg = /\[Removed from.*\]\((.*)\)/;
  var commentMap = {};
  interval = interval || 100;
  return bot.comments(mirror.permalink).then(function(comments) {
    comments = comments.map(function(cmt) {return cmt.data;}).filter(function(comment) {return comment.author===config.user;});
    var knownPosts = _.uniq(comments.filter(function(comment) {return comment.body.match(mirrorReg);}).map(function(comment) {
      var permalink = comment.body.match(mirrorReg)[1];
      commentMap[permalink] = comment;
      return permalink;
    }));
    var removed = _.uniq(comments.filter(function(comment) {return comment.body.match(reportReg);}).map(function(comment) {
      var permalink = comment.body.match(reportReg)[1];
      commentMap[permalink] = comment;
      return permalink;
    }));
    knownPosts = _.difference(knownPosts, removed);
    if (!knownPosts.length) {return Nodewhal.schedule.wait();}
    return anon.duplicates(config.mirrorSubreddit, mirror.name).then(function(duplicates) {
      var dupes = [];
      duplicates.forEach(function(listing) {
        if (!listing || !listing.data || !listing.data.children) {return;}
        listing.data.children.forEach(function(child) {dupes.push(child.data.permalink);});
      });
      return knownPosts.filter(function(post) {return dupes.indexOf(post)===-1;});
    }).then(function(removed) {
      if (!removed.length) {return Nodewhal.schedule.wait();}
      return Nodewhal.schedule.runInSeries(removed.map(function(url) {
        var id = 't3_' + url.split('/comments/').pop().split('/')[0];
        return function() {
          return bot.byId(id).then(function(post) {
            if (post.author === '[deleted]') {return;}
            if (post.is_self && (post.selftext || !post.selftext_html || !post.selftext_html.match('removed'))) {return;}
            return reportRemoval(post, mirror, commentMap[url]);
          });
        };
      }));
    });
  });
}

function reportRemoval(post, mirror, mirrorComment) {
  return bot.checkForShadowban(post.author).then(function() {
    var url = 'http://reddit.com' + post.permalink;
    return bot.submitted(config.reportSubreddit, entities.decode(url)).then(function(submitted) {
      if (typeof submitted === 'object') {
        //return bot.byId(submitted[0].data.children[0].data.name);
      } else {
        return bot.submit(config.reportSubreddit, 'link',
          entities.decode(post.title), url
        ).then(function(report) {return bot.byId(report.name);}).then(function(report) {
          return bot.comments(post.permalink).then(function(comments) {
            var modComment = comments.map(function(cmt) {return cmt.data;}).filter(function(comment) {
              return !!comment.distinguished;
            }).pop();
            var context = {post: post, report:report, mirror:mirror, modComment:modComment};
            var tasks = [bot.editusertext(mirrorComment.name, templates.mirrorRemoval(context))];
            if (modComment || post.link_flair_text) {
              tasks.push(bot.comment(report.name, templates.reportRemoval(context)));
            }
            return RSVP.all(tasks).then(function() {
              var flairClass = 'removed'; if (post.link_flair_text) {flairClass = 'flairedremoval';}
              return RSVP.all([
                bot.flair(report.subreddit, report.name, flairClass, post.subreddit+'|'+post.author),
                bot.flair(mirror.subreddit, mirror.name, 'removed', mirror.link_flair_text)
              ]).then(function() {return report;});
            });
          });
        });
      }
    });
  }).then(undefined, function(error) {
    if ((error+'').match(/shadowban/)) {return;}
    console.error("Reporting error", error.stack || error);
  });
}

function checkMentions(interval) {
  interval = interval || 60*1000*5;
  return Nodewhal.schedule.repeat(function() {
    return bot.mentions().then(function(mentions) {
      mentions = mentions.filter(function(mention) {
        return !!mention['new'] && !handledMentions[mention.context];
      }); if (!mentions.length) {return;}
      return Nodewhal.schedule.runInSeries(mentions.map(function(mention) {
        var context = mention.context; if (!context) {return;};
        handledMentions[mention.context] = true;
        return bot.byId('t3_' + context.split('/')[4]).then(mirrorSubmission);
      }));
    }).then(undefined, function(error) {
      console.error("Mentions error", error.stack || error);
    });
  }, interval);
}
