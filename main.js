module.exports = function(cfg, templates, trackNewPosts) {
var RSVP = require('rsvp'), Nodewhal = require('nodewhal'), _ = require('underscore');
var entities = new (require('html-entities').AllHtmlEntities)();
var bot = Nodewhal(cfg.userAgent), schedule = Nodewhal.schedule;
var submissionQueue = [], reportQueue = {}, updateQueue = {}, knownPostNames = {}; 
var reportSub = cfg.reportSubreddit, mirrorSub = cfg.mirrorSubreddit;
bot.config = cfg; bot.knownUrls = {};
console.log('\n   ======= ' + cfg.user + ' | ' + cfg.userAgent + ' =======\n');

if (!trackNewPosts) {trackNewPosts = function() {return RSVP.resolve();};}
return bot.login(cfg.user, cfg.password).then(function() {
  return fetchMirrors(10).then(function() {return RSVP.all([
    trackNewPosts(bot, newPost), mainLoop(), mainLoop(), schedule.repeat(fetchMirrors, 6*60*60*1000)
  ]);});
}).catch(function(error) {console.error("Err", error);});

function mainLoop() {
  return schedule.repeat(function() {
    console.log({
      known: Object.keys(bot.knownUrls).length,
      report: Object.keys(reportQueue).length,
      mirror: submissionQueue.length,
      update: Object.keys(updateQueue).length
    });
    if (Object.keys(reportQueue).length) {
      var removal = reportQueue[_.sample(Object.keys(reportQueue))];
      return reportRemoval(removal.post, removal.mirror);
    } else if (submissionQueue.length) {
      return mirrorPost(submissionQueue.pop());
    } else if (Object.keys(updateQueue).length) {
      var name = _.sample(Object.keys(updateQueue));   
      if (!name) {return RSVP.resolve();}
      return update(updateQueue[name]);   
    } else {return fetchMirrors(100);}
  });
}

function fetchMirrors(count, avoidUpdate) {
  return RSVP.all(['/r/' + mirrorSub, '/r/' + mirrorSub + '/new'].map(function(path) {
    return bot.listing(path, {max: count || 1000}).then(function(posts) {
      Object.keys(posts).forEach(function(key) {
        var post = posts[key];
        if (!post.is_self && post.url) {bot.knownUrls[posts.url] = true;}
        if (!avoidUpdate) {updateQueue[posts[key].name] = posts[key];}
      });
    });
  })).then(function(sets) {return _.union.apply(_,sets);});
}

function newPost(post) {
  if (!post.is_self && post.url) {bot.knownUrls[post.url] = true;}
  if (!knownPostNames[post.name]) {knownPostNames[post.name] = true;
    if (submissionQueue.filter(function(s) {return s.name === post.name;}).length) {return;}
    submissionQueue.splice(0, 0, post);
    return post;
  }
}

function quoteComment(comment) {
  if (!comment) {return;}
  var body = comment.body || '';
  comment.quoted = body.split('\n').map(function(line) {
    return '> ' + line;
  }).join('\n');
  return comment;
}

function decodePost(post) {
  post.title = entities.decode(post.title);
  if (post.selftext) {
    post.selftext = entities.decode(post.selftext);
  }
  return post;
}

function mirrorPost(post) {
  if (post && post.author !== '[deleted]') {
    if (!post.is_self && post.url) {bot.knownUrls[post.url] = true;}
    return bot.submitted(mirrorSub, entities.decode(post.url)).then(function(submitted) {
      if (typeof submitted === 'object') {return bot.byId(submitted[0].data.children[0].data.name);}
      return bot.submit(mirrorSub, 'link',
        entities.decode(post.title), entities.decode(post.url)
      ).then(function(j) {return bot.byId(j.name);}).then(function(mirror) {
        return bot.flair(mirrorSub, mirror.name, 'meta', 'r/'+post.subreddit)
          .then(function() {return mirror;});
      });
    }).then(function(mirror) {return update(mirror, post);});
  } else {return RSVP.resolve();}
}

function reportRemoval(post, mirror) {delete(reportQueue[post.name]);
  var url = bot.baseUrl + post.permalink;
  if (post.author === '[deleted]') {return RSVP.resolve();}
  return bot.submitted(reportSub, entities.decode(url)).then(function(submitted) {
    if (typeof submitted === 'object') {return bot.byId(submitted[0].data.children[0].data.name);}
    return bot.submit(reportSub, 'link', entities.decode(post.title), url);
  }).then(function(report) {return bot.byId(report.name);}).then(function(report) {
    return bot.comments(post.permalink).then(function(comments) {
      var comment = (comments.filter(function(j) {return !!j.data.distinguished;}).pop() || {}).data;
      var flairClass = 'removed'; if (post.link_flair_text || comment) {flairClass = 'flairedremoval';}
      var ctx = {
        post: decodePost(post), 
        report: decodePost(report), 
        mirror: decodePost(mirror), 
        modComment: quoteComment(comment)
      };
      var tasks = [
        bot.flair(report.subreddit, report.name, flairClass, post.subreddit+'|'+post.author),
        bot.flair(mirror.subreddit, mirror.name, 'removed', mirror.link_flair_text)
      ];
      if (flairClass !== 'removed') {
        return bot.comments(report.permalink).then(function(comments) {
          return comments.map(function(j) {return j.data;}).filter(function(j) {return j.author===bot.user;})[0];
        }).then(function(botComment) {
          var body = templates.report(ctx);
          if (!body.trim()) {return RSVP.all(tasks);}
          if (botComment) {
            if (botComment.body.trim() !== body.trim()) {
              tasks.push(bot.editusertext(botComment.name, body));
            }
          } else {
            tasks.push(bot.comment(report.name, body));
          }
          return RSVP.all(tasks);
        });
      }
      return RSVP.all(tasks);
    });
  }).catch(function(error) {if ((error+'').match(/shadowban/)) {return;} throw error;});
}

function update(mirror, knownPost) {delete(updateQueue[mirror.name]);
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
  
  return bot.comments(mirror.permalink).then(function(comments) {
    return comments.map(function(j) {return j.data;}).filter(function(j) {return j.author===bot.user;})[0];
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
    return bot.duplicates(mirrorSub, mirror.name).then(function(duplicates) {
      return _.union.apply(_, duplicates.map(function(listing) {
        if (!listing || !listing.data || !listing.data.children) {return [];}
        return listing.data.children.map(function(j) {return j.data;}).filter(function(child) {
          knownPostNames[child.name] = true;
          postMap[normUrl(child.permalink)] = child; 
          return (!_.contains([reportSub.toLowerCase(), mirrorSub.toLowerCase()], child.subreddit.toLowerCase()));
        }).map(function(child) {return child.permalink;}).map(normUrl);
      }));
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
        posts.forEach(function(post) {reportQueue[post.name] = {post: post, mirror: mirror};});
      }).then(function() {
        return RSVP.all([
          RSVP.all(_.uniq(knownPosts).map(getPost)).then(function(j) {
            postData.dupes = j.map(decodePost);
          }), RSVP.all(_.uniq(removed.map(getPost))).then(function(j) {
            postData.removed = j.map(decodePost);
          })
        ]).then(function() {return templates.mirror(postData);}).then(function(body) {
          if (!body.trim()) {return;}
          if (!botComment) {return bot.comment(mirror.name, body);}
          else if (body.trim() !== entities.decode(botComment.body.trim())) {
            return bot.editusertext(botComment.name, body);}
        });
      });
    });
  });
}
}; // End export
