module.exports = function(cfg, templates, trackNewPosts) {
var RSVP = require('rsvp'), Nodewhal = require('nodewhal'), _ = require('underscore');
var entities = new (require('html-entities').AllHtmlEntities)();
var bot = Nodewhal(cfg.userAgent);
var submissionQueue = [], reportQueue = {}, inspectQueue = {}, knownPostNames = {}; 
var reportSub = cfg.reportSubreddit, mirrorSub = cfg.mirrorSubreddit, minAuthorAge = cfg.minAuthorAge;
bot.config = cfg;

if (!trackNewPosts) {trackNewPosts = function() {return RSVP.resolve();};}
return bot.login(cfg.user, cfg.password).then(function() {
  return RSVP.all([trackNewPosts(bot, newPost), Nodewhal.schedule.repeat(function() {
    if (submissionQueue.length) {
      submissionQueue = _.shuffle(submissionQueue);
      return mirrorPost(submissionQueue.pop());
    } else if (Object.keys(reportQueue).length) {
      var removal = reportQueue[Object.keys(reportQueue).pop()];
      return reportRemoval(removal.post, removal.mirror, removal.comment);
    } else if (Object.keys(inspectQueue).length) {
      var name = _.sample(Object.keys(inspectQueue));   
      if (!name) {return RSVP.resolve();}
      return inspect(inspectQueue[name]);   
    } else {return bot.listing('/r/'+mirrorSub, {max: 1000}).then(function(posts) {
      Object.keys(posts).forEach(function(key) {inspectQueue[posts[key].name] = posts[key];});
    });}
  })]);
}).catch(function(error) {console.error("Err", error);});

function newPost(post) {
  if (!knownPostNames[post.name]) {knownPostNames[post.name] = true;
    if (submissionQueue.filter(function(s) {return s.name === post.name;}).length) {return;}
    return submissionQueue.push(post);
  }
}

function mirrorPost(post) {
  if (post && post.author !== '[deleted]') {
    return bot.aboutUser(post.author).then(function(author) {
      var authorAge = post.created_utc - author.created_utc;
      if (authorAge < minAuthorAge) {return;}
      return bot.submitted(mirrorSub, entities.decode(post.url)).then(function(submitted) {
        if (typeof submitted === 'object') {
          return bot.byId(submitted[0].data.children[0].data.name);
        } else {
          return bot.submit(mirrorSub, 'link',
            entities.decode(post.title), entities.decode(post.url)
          ).then(function(j) {return bot.byId(j.name);}).then(function(mirror) {
            return RSVP.all([
              bot.flair(mirrorSub, mirror.name, 'meta', post.subreddit + '|' + post.author),
              bot.comment(mirror.name, templates.mirror({post: post, mirror: mirror}))
            ]).then(function() {return mirror;});
          });
        }
      }).then(inspect);
    }).catch(function(err) {if (err === 'usermissing') {return;} throw err;});
  } else {return RSVP.resolve();}
}

function reportRemoval(post, mirror, mirrorComment) {
  var url = bot.baseUrl + post.permalink;
  delete(reportQueue[post.name]);
  return bot.submitted(reportSub, entities.decode(url)).then(function(submitted) {
    if (typeof submitted === 'object') {return;}
    return bot.submit(reportSub, 'link', entities.decode(post.title), url
    ).then(function(report) {return bot.byId(report.name);}).then(function(report) {
      return bot.comments(post.permalink).then(function(comments) {
        var comment = (comments.filter(function(j) {return !!j.data.distinguished;}).pop() || {}).data;
        var ctx = {post: post, report:report, mirror:mirror, modComment:comment};
        var flairClass = 'removed'; if (post.link_flair_text || comment) {flairClass = 'flairedremoval';}
        var tasks = [
          bot.editusertext(mirrorComment.name, templates.mirrorRemoval(ctx)),
          bot.flair(report.subreddit, report.name, flairClass, post.subreddit+'|'+post.author),
          bot.flair(mirror.subreddit, mirror.name, 'removed', mirror.link_flair_text)
        ];
        if (flairClass !== 'removed') {tasks.push(bot.comment(report.name, templates.reportRemoval(ctx)));}
        return RSVP.all(tasks);
      });
    });
  }).catch(function(error) {if ((error+'').match(/shadowban/)) {return;} throw error;});
}

function inspect(mirror) {
  var commentMap = {};
  delete(inspectQueue[mirror.name]);
  return bot.comments(mirror.permalink).then(function(comments) {
    return comments.map(function(j) {return j.data;}).filter(function(j) {return j.author===bot.user;});
  }).then(function(comments) {
    var removed = getLinks(comments, /\[Removed from.*\]\((.*)\)/);
    var knownPosts = _.difference(getLinks(comments, /\[Original Submission.*\]\((.*)\)/), removed);
    function getLinks(cmts, reg) {
      return _.uniq(cmts.filter(function(j) {return j.body.match(reg);}).map(function(comment) {
        var permalink = comment.body.match(reg)[1];
        commentMap[permalink] = comment;
        return permalink;
      }));
    }
    if (!knownPosts.length) {return RSVP.resolve();}
    return bot.duplicates(mirrorSub, mirror.name).then(function(duplicates) {
      var dupes = [];
      var missing = [];
      duplicates.forEach(function(listing) {if (!listing || !listing.data || !listing.data.children) {return;}
        listing.data.children.map(function(j) {return j.data;}).filter(function(child) {
          return (child.subreddit !== reportSub) && (child.subreddit !== mirrorSub);
        }).forEach(function(child) {dupes.push(child.permalink);
          if (!commentMap[child.permalink]) {missing.push(child);}
        });
      });
      var removed = knownPosts.filter(function(post) {return dupes.indexOf(post)===-1;});
      if (!missing.length) {return removed;}
      return RSVP.all(missing.map(function(post) {knownPostNames[post.name] = true;
        return bot.comment(mirror.name, templates.mirror({post: post, mirror: mirror}));
      })).then(function() {return removed;});
    }).then(function(removed) {if (!removed.length) {return;}
      return Nodewhal.schedule.runInSeries(removed.map(function(url) {return function() {
        var id = 't3_' + url.split('/comments/').pop().split('/')[0];
        return bot.byId(id).then(function(post) {
          if (post.author === '[deleted]') {return;}
          if (post.is_self && (post.selftext || !post.selftext_html || !post.selftext_html.match('removed'))) {
            return;
          } reportQueue[post.name] = {post: post, mirror: mirror, comment: commentMap[url]};
        });
      };}));
    });
  });
}

}; // End export
