var RSVP = require('rsvp'), schedule = require('../schedule');
var _ = require('underscore');
var mirrored = {};

module.exports = function(bot) {
  var handled = {}, linkMap = {};
  var mirrorSub = bot.config.mirrorSubreddit;
  bot.mirrorUrl = mirrorUrl;

  function getTopicalUrls() {
    if (!bot.topicSubs.length) {return RSVP.resolve([]);}
    var promises = bot.topicSubs.map(function(sub) {return bot.data.read(sub);});
    return RSVP.all(promises).then(function(res) {
      return res.map(function(db) {
        if (!db.t3) {console.log(db); process.exit();}
        return _.uniq(_.compact(_.pluck(db.t3.find(), 'url')));
      });
    }).then(function(urlSets) {return _.union.apply(_, urlSets);});
  }

  function getUnmirrored() {
    return bot.data.read(mirrorSub).then(function(db) {
      if (!db.t3) {console.log(db); process.exit();}
      return _.uniq(_.compact(_.pluck(db.t3.find(), 'url')));
    }).then(function(mirrored) {
      return getTopicalUrls().then(function(topical) {
        return _.difference(topical, mirrored);
      });
    }).then(function(unmirrored) {
      return unmirrored.filter(function(j) {return !mirrored[j];});
    });
  }

  function mirrorUrl(url) {
    var existingMirror;
    if (mirrored[url]) {return RSVP.resolve();}
    mirrored[url] = true;
    return bot.submitted(undefined, url).then(function(known) {
      return _.sortBy(known, function(j) {return j.score}).reverse();
    }).then(function(known) {
      var blacklist = bot.subs.concat(config.blacklist || []).map(function(j) {return j.toLowerCase();});
      existingMirror = _.first(_.where(known, {subreddit: mirrorSub}));
      if (existingMirror) {return;}
      var posts = known.filter(function(j) {
        return j.author !== '[deleted]' && !_.contains(blacklist, j.subreddit.toLowerCase());
      });
      var topicPosts = posts.filter(function(j) {return _.contains(
        bot.topicSubs, j.subreddit.toLowerCase());
      });
      return _.first(topicPosts) || _.first(posts);
    }).then(function(post) {
      if (!post) {
        if (!existingMirror) {return;}
        return bot.data.edit(existingMirror.subreddit, undefined, function(db) {
          if (db.t3.find({url:url}).length) {return;}
          db.t3.insert({
            id: existingMirror.id,
            is_self: existingMirror.is_self,
            url: url
          });
        });
      }
      return bot.submit({
        kind: 'link',
        sr: mirrorSub,
        title: post.title,
        url: post.url,
        sendreplies: false
      }).then(function(j) {return bot.byId(j.name);}).then(function(mirror) {
        mirror.link_flair_text = 'r/' + post.subreddit;
        return bot.flair({
          r: mirrorSub,
          link: mirror.name,
          css_class: 'meta',
          text: mirror.link_flair_text
        }).then(function() {return mirror;});
      }).then(bot.updateOtherDiscussions);
    });
  }

  function getPost(url) {return bot.byId(url.split('/comments/').pop().split('/')[0]);}
  return RSVP.all([schedule.repeat(function() {var handled = {};
    if (!bot.topicSubs.length) {return RSVP.resolve();}
    return RSVP.all([
      //bot.listing('/r/'+subreddits.join('+')+'/new', 100).then(function(posts) {posts.forEach(mirror);}),
      bot.mentions().then(function(mentions) {
        var posts = mentions.filter(function(mention) {
          return !!mention['new'] && !handled[mention.context];
        }).map(function(mention) {
          var context = mention.context; if (!context) {return;};
          handled[mention.context] = true;
          return bot.byId(context.split('/')[4]).then(function(post) {
            return mirrorUrl(post.url);
          });
        }); if (posts.length) {return RSVP.all(posts);}
      }),
    ]);
  }, 60*1000), schedule.repeat(function() {
    return bot.myMultis().then(function(data) {
      return data.map(function(i) {
        if (_.contains(['blacklist', 'transparency'], i.data.name.toLowerCase())) {
          config.blacklist = _.union(config.blacklist, i.data.subreddits.map(function(j) {return j.name;}));
          return [];
        }
        return i.data.subreddits;
      });
    }).then(function(multis) {
      return _.union.apply(_, multis).map(function(sub) {return sub.name.toLowerCase();});
    }).then(function(subs) {bot.topicSubs = subs;});
  }, 30*1000), pollForUnpostedMirrors()
]);

function pollForUnpostedMirrors() {
  return schedule.repeat(function() {
    return getUnmirrored().then(function(urls) {
      if (!urls.length) {return;} console.log('unmirrored', urls.length);
      return schedule.runInSeries(_.shuffle(urls).map(function(url) {
        return function() {return mirrorUrl(url);};
      }));
    });
  });
}};
