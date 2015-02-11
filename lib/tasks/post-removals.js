var RSVP = require('rsvp'), schedule = require('../schedule'), _ = require('underscore');
module.exports = function(bot, templates) {
var reportSub = bot.config.reportSubreddit, mirrorSub = bot.config.mirrorSubreddit;
var promise = schedule.repeat(function() {
  try {
    if (Object.keys(bot.reportQueue).length) {
      var removal = _.sample(_.values(bot.reportQueue));
      return reportRemoval(removal.post, removal.mirror);
    }
    return RSVP.resolve();
  } catch(e) {console.error(e.stack || e);}
});

bot.searchRemovedPosts = function(search) {
  var path = '/r/'+bot.config.reportSubreddit+'/search?sort=top&restrict_sr=on&t=all&q=' + encodeURIComponent('('+search+') AND author:' + bot.config.user);
  return bot.listing(path);
}

return promise;

function reportRemoval(post, mirror) {delete(bot.reportQueue[post.name]);
  var url = bot.baseUrl + post.permalink;
  if (_.contains(['[deleted]', bot.config.user.toLowerCase()], post.author.toLowerCase())) {return RSVP.resolve();}
  return bot.submitted(reportSub, url).then(function(submitted) {
    if (submitted && submitted.length) {return bot.byId(submitted[0].name);}
    var score = post.score; if (score>0) {score = '+' + score;}
    var type = 'Link';
    if (post.is_self) {type = 'Self-post';}
    return bot.submit({
      kind: 'link',
      sr: reportSub,
      title: post.title,
      //title: ([score, post.num_comments, type + ' by', '/u/'+post.author, '[REMOVED] from', '/r/'+post.subreddit,
      //  post.domain, post.title].join (' : ').slice(0, 296) + '...'),
      url: url,
      sendreplies: false
    }).then(function(report) {return bot.byId(report.name);});;
  }).then(function(report) {
    return bot.comments(post.subreddit, post.id).then(function(comments) {
      var comment = comments.filter(function(j) {return !!j.distinguished;}).pop();
      var flairClass = 'removed'; if (post.link_flair_text || comment) {flairClass = 'flairedremoval';}
      var ctx = {
        post: post,
        report: report,
        mirror: mirror,
        modComment: comment
      };
      var tasks = [
        bot.flair({
          r: report.subreddit,
          link: report.name,
          css_class: flairClass,
          text: post.subreddit+'|'+post.author
        }),
        bot.flair({
          r: mirror.subreddit,
          link: mirror.name,
          css_class: 'removed',
          text: mirror.link_flair_text
        })
      ];
      if (flairClass === 'removed') {
        if (bot.config.reportLiveThread) {
          tasks.push(bot.liveUpdate(bot.config.reportLiveThread, templates.livepost({
            report: report, comment: comment, post: post
          })));
        }
      } else {
        var commentsPromise = RSVP.resolve([]);
        if (post.num_comments) {commentsPromise = bot.comments(report.subreddit, report.id);}
        return commentsPromise.then(function(comments) {
          return _.compact(comments.map(function(j) {return j.data;}))
              .filter(function(j) {return j.author===bot.config.user;})[0];
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
          if (bot.config.reportLiveThread) {
            tasks.push(bot.liveUpdate(bot.config.reportLiveThread, templates.livepost({
              report: report, comment: comment, body: body, post: post
            })));
          }
          return RSVP.all(tasks);
        });
      }
      return RSVP.all(tasks);
    });
  }).catch(function(error) {if ((error+'').match(/shadowban/)) {return;} throw error;});
}

}; // End export
