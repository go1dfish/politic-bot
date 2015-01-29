var RSVP = require('rsvp'), schedule = require('../schedule'), _ = require('underscore');
module.exports = function(bot, templates) {
var reportSub = bot.config.reportSubreddit, mirrorSub = bot.config.mirrorSubreddit;
bot.queueMirror = newPost;
bot.updateOtherDiscussions = update;
bot.fetchMirrors = fetchMirrors;

return schedule.repeat(function() {
  if (Object.keys(bot.updateQueue).length) {
    var name = _.sample(Object.keys(bot.updateQueue));
    if (!name) {return RSVP.resolve();}
    return update(bot.updateQueue[name]);
  } return RSVP.resolve();
});

function fetchMirrors(count, avoidUpdate) {
  return RSVP.all(['/r/' + mirrorSub + '/hot', '/r/' + mirrorSub + '/new'].map(function(path) {
    return bot.listing(path).then(function(posts) {
      posts.forEach(function(post) {
        if (!post.is_self && post.url) {bot.knownUrls[post.url] = true;}
        if (!avoidUpdate) {bot.updateQueue[post.name] = post;}
      });
    });
  })).then(function(sets) {return _.union.apply(_,sets);});
}

function newPost(post) {
  if (!post.is_self && post.url) {bot.knownUrls[post.url] = true;}
  if (!bot.knownPostNames[post.name]) {bot.knownPostNames[post.name] = true;
    if (bot.submissionQueue.filter(function(s) {return s.name === post.name;}).length) {return;}
    bot.submissionQueue.splice(0, 0, post);
    return post;
  }
}

function update(mirror, knownPost) {
  delete(bot.updateQueue[mirror.name]);
  var missing = [], postMap = {};
  function normUrl(url) {return url.replace(bot.baseUrl, '');}
  function getPost(url) {
    url = normUrl(url);
    if (postMap[url]) {return RSVP.resolve(postMap[url]);} else {
      return bot.byId('t3_' + url.split('/comments/').pop().split('/')[0]).then(function(post) {
        postMap[url] = post; return post;
      });
    }
  }
  function getLinks(body, reg) {
    var matches = [], match;
    while (match = reg.exec(body)) {matches.push(match[1]);}
    return _.uniq(matches.map(normUrl));
  }
  if (!mirror.is_self && mirror.url) {bot.knownUrls[mirror.url] = true;}

  return bot.comments(mirror.subreddit, mirror.id).then(function(comments) {
    return comments.filter(function(j) {return j.author===bot.config.user;})[0];
  }).then(function(botComment) {
    var removed = [], knownPosts = [], missing = [];
    var blacklist = (bot.config.blacklist || []).concat([reportSub, mirrorSub]);
    blacklist = blacklist.map(function(j) {return j.toLowerCase();});
    if (botComment) {
      removed = getLinks(botComment.body, /(?:^ \* ~~\[\/r\/.*?\]\()(.*?)(?:\)~~)/mg);
      knownPosts = _.union(removed, getLinks(botComment.body, /(?:^ \* \[\/r\/.*?\]\()(.*?)(?:\))/mg));
    }
    if (knownPost) {
      var knownPostPermalink = normUrl(knownPost.permalink);
      postMap[knownPostPermalink] = knownPost;
      if (!_.contains(knownPosts, knownPostPermalink)) {knownPosts.push(knownPostPermalink);}
    }
    mirror.dupeslink = mirror.permalink.replace(/\/comments\//, '/duplicates/');
    return bot.duplicates(mirror).then(function(duplicates) {
      return duplicates.filter(function(child) {
        bot.knownPostNames[child.name] = true;
        postMap[normUrl(child.permalink)] = child;
        return (!_.contains([reportSub.toLowerCase(), mirrorSub.toLowerCase()], child.subreddit.toLowerCase()));
      }).map(function(child) {return child.permalink;}).map(normUrl);
    }).then(function(duplicates) {
      missing = _.union(duplicates, removed);
      missing = _.union(missing, _.difference(duplicates, knownPosts));
      knownPosts = _.union(knownPosts, duplicates);
      return _.difference(_.difference(knownPosts, duplicates), removed);
    }).then(function(detectedRemovals) {
      return RSVP.all(detectedRemovals.map(getPost)).then(function(posts) {
        return posts.filter(function(post) {
          if (post.author === '[deleted]') {return false;}
          if (post.is_self) {
            missing.push(normUrl(post.permalink));
            if (post.selftext || !post.selftext_html || !post.selftext_html.match('removed')) {return false;}
          }
          return true;
        }).map(function(post) {return normUrl(post.permalink);});
      });
    }).then(function(detectedRemovals) {var postData = {mirror:mirror};
      if (!(missing.length || !detectedRemovals.length)) {return;}
      removed = _.union(removed, detectedRemovals);
      knownPosts = _.difference(_.union(knownPosts, missing), removed);
      return RSVP.all(detectedRemovals.map(getPost)).then(function(posts) {
        posts.forEach(function(post) {bot.reportQueue[post.name] = {post: post, mirror: mirror};});
      }).then(function() {
        return RSVP.all([
          RSVP.all(_.uniq(knownPosts).map(getPost)).then(function(j) {postData.dupes=j;}),
          RSVP.all(_.uniq(removed.map(getPost))).then(function(j) {postData.removed=j;})
        ]).then(function() {return templates.mirror(postData);}).then(function(body) {
          if (!body.trim()) {return;}
          if (!botComment) {return bot.comment(mirror.name, body);}
          else if (body.trim() !== botComment.body.trim()) {
            return bot.editusertext(botComment.name, body);}
        });
      });
    });
  });
}
}; // End export
