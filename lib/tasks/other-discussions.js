var RSVP = require('rsvp'), schedule = require('../schedule'), _ = require('underscore');
module.exports = function(bot, templates) {
var moment = require('moment');
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
        bot.knownPosts[j.name] = true; if (!j.is_self) {return true;}
        return j.selftext || !j.selftext_html.match('removed');
      })).map(function(j) {dupes.push(j); return j;}).forEach(function(dupe) {
        removed = removed.filter(function(j) {
          if (removed.author == bot.config.user) {return false;}
          return j.id !== dupe.id;
        });
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
  if (!mirror) {return RSVP.resolve();}
  if (!mirror.permalink) {console.error('no permalink', mirror);}
  delete(bot.updateQueue[mirror.name]);
  if (!mirror.is_self && mirror.url) {bot.knownUrls[mirror.url] = true;}
  mirror.dupeslink = mirror.permalink.replace(/\/comments\//, '/duplicates/');
  return getOthers(mirror).then(function(current) {
    var posts = current.dupes.concat(current.removed);
    var ids = _.pluck(posts, 'id');
    var removedCommentsPromise = RSVP.resolve([]);
    var commentCount = _.reduce(_.pluck(current.dupes.concat(current.removed), 'num_comments'), function(memo, num){ return memo + num; }, 0);
    var seenIds = [];
    if (commentCount) {removedCommentsPromise = bot.getRemovedComments(ids);}
    posts.forEach(function(post) {
      seenIds = _.union(seenIds, _.pluck(bot.ingest.t1.find({link_id: post.name}), 'id'));
    });
    seenIds = _.uniq(_.compact(seenIds));
    return removedCommentsPromise.then(function(comments) {
      var path = '/r/'+bot.config.commentSubreddit+'/search?sort=top&restrict_sr=on&t=all&q=' + ids.join('+OR+');
      current.comments = comments.map(function(j) {
        var parts = j.title.split(' : ');
        var score = parts[0];
        var user = parts[2].split('/').pop();
        var subreddit = parts[4];
        var id = parts[5];
        var search = '/r/' + bot.config.commentSubreddit + '/search?sort=top&restrict_sr=on&q=';
        var userSearch = search + '%2Fu%2F' + user;
        var subSearch = search + subreddit;
        j.url = '/user/' + j.url.split('/user/').pop();
        j.links_md = [
          '[' + score + ' : ' + id + ']('+j.url+')',
          'by',
          '[' + user + '](' + userSearch + ')',
          'from',
          '[' + subreddit + '](' + subSearch + ')',
        ].join(' ');
        return j;
      });
      if (commentCount < current.comments) {commentCount = current.comments;}
      current.comments.permalink = path;
      current.comments.total = commentCount;
      current.comments.known = seenIds.length;
      if (commentCount) {
        current.comments.percentageRemoved = Math.round(
          100.0 * current.comments.length / commentCount
        ).toFixed(2);
      } else {current.comments.percentageRemoved = 0;}
      return current;
    });
  }).then(function(current) {
    function timestamp(commentBody) {
      return '###### ^(' + moment.utc().format('MMMM Do YYYY, HH:mm:ss') +' UTC)\n' + commentBody;
    }

    if (!(current.removed.length + (current.comments || []).length)) {return;}
    var commentsPromise = RSVP.resolve([]);
    if (mirror.num_comments) {commentsPromise = bot.comments(mirror.subreddit, mirror.id);}
    return commentsPromise.then(function(comments) {
      return comments.filter(function(j) {return j.author===bot.config.user;})[0];
    }).then(function(botComment) {
      var known = getOthersFromComment(botComment);
      if (known.removed.length===current.removed.length && !current.comments.length) {return;}
      var body = templates.mirror({mirror: mirror, removed: current.removed, comments: current.comments}).trim(); 
      current.removed.forEach(function(post) {
        if (_.contains(known.removed, post.permalink)) {return;}  
        bot.reportQueue[post.name] = {post: post, mirror: mirror};
      }); 
      if (!body) {return;} if (!botComment) {return bot.comment(mirror.name, timestamp(body));}
      var botBody = (botComment.body || '').trim().split('\n').pop().trim();
      if (body !== botBody) {return bot.editusertext(botComment.name, timestamp(body));}
    }).catch(function(error) {console.error(error.stack || error)}); 
  });
}
}; // End export
