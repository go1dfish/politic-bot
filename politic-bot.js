var RSVP = require('rsvp'), fs = require('fs'), Handlebars = require('handlebars'), Nodewhal = require('nodewhal');
var _ = require('underscore'), config = require('./config'), pkg = require('./package');
var mirrorSub = config.mirrorSubreddit.toLowerCase(), reportSub = config.reportSubreddit.toLowerCase();
var subreddits = [], botSubs = [mirrorSub, reportSub], schedule = Nodewhal.schedule; 
config.userAgent = pkg.name+'/'+pkg.version+' by '+pkg.author;

require('./main')(config, {
  mirror: Handlebars.compile(fs.readFileSync('./templates/mirror.md.hbs')+''),
  report: Handlebars.compile(fs.readFileSync('./templates/report.md.hbs')+''),
}, function(bot, mirror) {
  var handled = {};
  function getPost(url) {return bot.byId('t3_' + url.split('/comments/').pop().split('/')[0]);}
  if (config.streamUrl) {bot.streamUrl = config.streamUrl;} else {require('reddit-stream');
    bot.streamUrl = "http://localhost:4243/submission_stream?eventsource=true";
  }
  return RSVP.all([schedule.repeat(function() {var handled = {};
    return RSVP.all([
      bot.listing('/me/m/monitored/new', {max:25}).then(function(posts) {
        Object.keys(posts).map(function(j) {return posts[j];}).forEach(mirror);
      }), bot.mentions().then(function(mentions) {
        var posts = mentions.filter(function(mention) {
          return !!mention['new'] && !handled[mention.context];
        }).map(function(mention) {
          var context = mention.context; if (!context) {return;};
          var name = 't3_' + context.split('/')[4]; handled[mention.context] = true;
          return bot.byId(name).then(mirror);
        }); if (posts.length) {return RSVP.all(posts);}
      })
    ]); 
  }, 60*1000), schedule.repeat(function() {
    return bot.get(bot.baseUrl + '/api/multi/mine').then(function(data) {
      return data.map(function(i) {return i.data;}).filter(function(item) {return item.name === 'monitored';
      })[0].subreddits.map(function(sub) {return sub.name.toLowerCase();});
    }).then(function(subs) {subreddits = subs;});
  }, 5*60*1000), bot.startSubmissionStream(function(post) {
    var postSub = post.subreddit.toLowerCase(), postTitle = post.title.toLowerCase(), postSelf = post.selftext;
    var blacklist = (config.blacklist || []).map(function(j) {return j.toLowerCase();});
    if (postSelf) {postSelf = postSelf.toLowerCase();}
    if (_.contains(blacklist.concat(botSubs), postSub)) {return;}
    if (_.contains(subreddits, post.subreddit.toLowerCase()) || bot.knownUrls[post.url]) {
      mirror(post);
    } else if (subreddits.filter(function(sub) {return postTitle.indexOf('r/'+sub) !== -1;}).length) {
      mirror(post);
    } else if (subreddits.filter(function(sub) {return post.url.toLowerCase().match('/r/'+sub+'/');}).length) {
      return getPost(post.url).then(mirror).then(function() {
        if (post.subreddit.match(/(undele|uncens|pagewatch|longtail|remov)/i)) {return;}
        return mirror(post);
      });
    } else if (postTitle.match(bot.user.toLowerCase())) {mirror(post);}
    else if (postSelf && subreddits.filter(function(j) {return postSelf.match('/r/'+j);}).length) {mirror(post);} 
    else if (postSelf && botSubs.filter(function(j) {return postSelf.match('r/'+j);}).length) {mirror(post);}
    else if (postSelf && postSelf.match(bot.user.toLowerCase())) {mirror(post);}
  })]);
});
