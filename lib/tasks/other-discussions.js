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
  return RSVP.all([
    bot.listing('/r/' + mirrorSub + '/hot'),
    bot.listing('/r/' + mirrorSub + '/new'),
    //bot.listing('/r/' + mirrorSub + '/top', null, {t: 'month'}),
    bot.listing('/r/' + mirrorSub + '/top', null, {t: 'day'}),
    bot.listing('/r/' + mirrorSub + '/top', null, {t: 'week'})
  ]).then(function(listings) {return _.union.apply(_, listings);}).then(function(posts) {
    return posts.map(function(post) {
      if (!post.is_self && post.url) {bot.knownUrls[post.url] = true;}
      if (!avoidUpdate) {bot.updateQueue[post.name] = post;}
      return post;
    });
  });
}

function newPost(post) {
  if (!post.is_self && post.url) {bot.knownUrls[post.url] = true;}
  if (!bot.knownPostNames[post.name]) {bot.knownPostNames[post.name] = true;
    if (bot.submissionQueue.filter(function(s) {return s.name === post.name;}).length) {return;}
    bot.submissionQueue.splice(0, 0, post);
    return post;
  }
}

function getOthers(post) {
  var blacklist = (bot.config.blacklist || []).concat([reportSub, mirrorSub]);
  blacklist = blacklist.map(function(j) {return j.toLowerCase();});
  return bot.submitted(undefined, post.url).then(function(known) {
    var dupes = [];
    function filterPost(j) {
      if (j.id === post.id || j.author === '[deleted]') {return false;}
      return !_.contains(blacklist, (j.subreddit || '').toLowerCase());
    }
    var removed = known.filter(filterPost);
    return bot.duplicates(post).then(function(duplicates) {
      duplicates.filter(filterPost).concat(_.where(removed, {is_self: true}).filter(function(j) {
        bot.knownPosts[post.name] = true;
        return post.selftext || !post.selftext_html.match('removed');
      })).map(function(j) {dupes.push(j); return j;}).forEach(function(dupe) {
        removed = removed.filter(function(j) {return j.id !== dupe.id;});
      }); 
      return {dupes: dupes, removed: removed};
    });
  });
}

function getOthersFromComment(comment) {
  function normUrl(url) {return url.replace(bot.baseUrl, '');}
  function getLinks(body, reg) {
    var matches = [], match;
    while (match = reg.exec(body)) {matches.push(match[1]);}
    return _.uniq(matches.map(normUrl));
  }
  if (!comment) {return {dupes: [], removed: []};}
  return {
    dupes: getLinks(comment.body, /(?:^ \* \[\/r\/.*?\]\()(.*?)(?:\))/mg),
    removed: getLinks(comment.body, /(?:^ \* ~~\[.*?\]\()(.*?)(?:\)~~)/mg)
  };
}

function update(mirror) {
  delete(bot.updateQueue[mirror.name]);
  if (!mirror.is_self && mirror.url) {bot.knownUrls[mirror.url] = true;}
  mirror.dupeslink = mirror.permalink.replace(/\/comments\//, '/duplicates/');
  return bot.comments(mirror.subreddit, mirror.id).then(function(comments) {
    return comments.filter(function(j) {return j.author===bot.config.user;})[0];
  }).then(function(botComment) {
    var known = getOthersFromComment(botComment);
    return getOthers(mirror).then(function(current) {
      if (known.removed.length===current.removed.length) {return;}
      var body = templates.mirror({mirror: mirror, removed: current.removed}).trim(); 
      current.removed.forEach(function(post) {
        if (_.contains(known.removed, post.permalink)) {return;}  
        bot.reportQueue[post.name] = {post: post, mirror: mirror};
      }); 
      if (!body) {return;} if (!botComment) {return bot.comment(mirror.name, body);}
      else if (body !== botComment.body.trim()) {return bot.editusertext(botComment.name, body);}
    }); 
  });
}
}; // End export
