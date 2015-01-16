var RSVP = require('rsvp'), fs = require('fs'), Handlebars = require('handlebars'), Nodewhal = require('nodewhal');
require('./politic-bot')(require('./config'), {
  mirror: Handlebars.compile(fs.readFileSync('./templates/mirror-comment-template.hbs')+''),
  reportRemoval: Handlebars.compile(fs.readFileSync('./templates/report-removal-comment-template.hbs')+''),
  mirrorRemoval: Handlebars.compile(fs.readFileSync('./templates/mirror-removal-comment-template.hbs')+'')
}, function(bot, newPost) {
  var handled = {};
  if (bot.config.streamUrl) {bot.streamUrl = bot.config.streamUrl;} else {require('reddit-stream');
    bot.streamUrl = "http://localhost:4243/submission_stream?eventsource=true";
  }
  return RSVP.all([Nodewhal.schedule.repeat(function() {
    return RSVP.all([
      bot.listing('/me/m/monitored/new', {max:25}).then(function(posts) {
        Object.keys(posts).map(function(j) {return posts[j];}).forEach(newPost);
      }), bot.mentions().then(function(mentions) {
        var posts = mentions.filter(function(mention) {
          return !!mention['new'] && !handled[mention.context];
        }).map(function(mention) {
          var context = mention.context; if (!context) {return;};
          var name = 't3_' + context.split('/')[4]; handled[mention.context] = true;
          return bot.byId(name).then(newPost);
        }); if (posts.length) {return RSVP.all(posts);}
      })
    ]); 
  }, 60*1000),
  bot.get(bot.baseUrl + '/api/multi/mine').then(function(data) {
    return data.map(function(i) {return i.data;}).filter(function(item) {
      return item.name === 'monitored';
    })[0].subreddits.map(function(sub) {return sub.name;});
  }).then(function(subreddits) {return bot.startSubmissionStream(newPost, subreddits);})]);
});
