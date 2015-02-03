var RSVP = require('rsvp'), schedule = require('../schedule');
var _ = require('underscore');

module.exports = function(bot) {
  var handled = {}, linkMap = {};
  var mirrorSub = bot.config.mirrorSubreddit;
  var reportSub = config.reportSubreddit;
  var botSubs = [mirrorSub, reportSub, config.commentSubreddit];
  botSubs = botSubs.map(function(j) {return j.toLowerCase();});
  bot.mirrorPostNow = mirrorPost;

  function mirrorPost(post) {
    if (post && post.author !== '[deleted]') {
      if (!post.is_self && post.url) {bot.knownUrls[post.url] = true;}
      bot.knownPosts[post.name] = true;
      return bot.submitted(mirrorSub, post.url).then(function(submitted) {
        if (submitted && submitted.length) {return bot.byId(submitted[0].name);}
        return bot.submit({
          kind: 'link',
          sr: mirrorSub,
          title: post.title,
          url: post.url
        }).then(function(j) {return bot.byId(j.name);}).then(function(mirror) {
          return bot.flair({
            r: mirrorSub,
            link: mirror.name,
            css_class: 'meta',
            text: 'r/' + post.subreddit
          }).then(function() {return mirror;});
        });
      }).then(bot.updateOtherDiscussions);
    } else {return RSVP.resolve();}
  }

  function getPost(url) {return bot.byId(url.split('/comments/').pop().split('/')[0]);}
  function mirror(post) {
    var linkNames = linkMap[post.url] = linkMap[post.url] || [];
    linkMap[post.url] = linkNames = linkNames.filter(function(j) {return j.name !== post.name;});
    if (linkNames.length) {
      RSVP.all(linkNames.map(bot.byId)).then(function(posts) {
        return RSVP.all(posts.map(function(post) {
          linkMap[post.url] = linkNames = _.without(linkNames, post.name);
          return bot.queueMirror(post);
        }));
      }).catch(function(err) {console.error(err.stack || err);});
    }
    return bot.queueMirror(post);
  }
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
          return bot.byId(context.split('/')[4]).then(mirrorPost);
        }); if (posts.length) {return RSVP.all(posts);}
      }),
    ]);
  }, 60*1000), schedule.repeat(function() {
    return bot.myMultis().then(function(data) {
      return data.map(function(i) {
        if (i.data.name.toLowerCase() === 'blacklist') {
          config.blacklist = i.data.subreddits.map(function(j) {return j.name;});
          return [];
        }
        return i.data.subreddits;
      });
    }).then(function(multis) {
      return _.union.apply(_, multis).map(function(sub) {return sub.name.toLowerCase();});
    }).then(function(subs) {bot.topicSubs = subs;});
  }, 5*60*1000), bot.itemStream(bot.postStreamUrl, function(post) {
    var postSub = post.subreddit.toLowerCase(), postTitle = post.title.toLowerCase(), postSelf = post.selftext;
    var blacklist = (config.blacklist || []).map(function(j) {return j.toLowerCase();});
    if (postSelf) {postSelf = postSelf.toLowerCase();}
    if (post.author === bot.config.user) {return;}
    if (_.contains(blacklist.concat(botSubs), postSub)) {return;}
    if (_.contains(bot.topicSubs, post.subreddit.toLowerCase())) {
      mirror(post);
    } else if (bot.topicSubs.filter(function(sub) {return postTitle.indexOf('r/'+sub) !== -1;}).length) {
      mirror(post);
    } else if (bot.topicSubs.filter(function(sub) {return post.url.toLowerCase().match('/r/'+sub+'/');}).length) {
      return getPost(post.url).then(mirror).then(function() {
        if (post.subreddit.match(/(undele|uncens|pagewatch|longtail|remov)/i)) {return;}
        return mirror(post);
      });
    } else if (postTitle.match(bot.config.user.toLowerCase())) {mirror(post);}
    else if (postSelf && bot.topicSubs.filter(function(j) {return postSelf.match('/r/'+j);}).length) {mirror(post);}
    else if (postSelf && botSubs.filter(function(j) {return postSelf.match('r/'+j);}).length) {mirror(post);}
    else if (postSelf && postSelf.match(bot.config.user.toLowerCase())) {mirror(post);}
    else if (!_.contains(botSubs, postSub)) {var linkNames = linkMap[post.url] = linkMap[post.url] || [];
      if (!_.contains(linkNames, post.name)) {linkNames.push(post.name);}
    }
  }), pollForUnpostedMirrors()
]);

function pollForUnpostedMirrors() {
  return schedule.repeat(function() {
    if (bot.submissionQueue.length) {
      console.log({
        known: Object.keys(bot.knownUrls).length,
        report: Object.keys(bot.reportQueue).length,
        mirror: bot.submissionQueue.length,
        update: Object.keys(bot.updateQueue).length,
        comments: _.keys(bot.knownComments).length
      });
      return mirrorPost(bot.submissionQueue.pop());
    } return RSVP.resolve();
  });
}
};
