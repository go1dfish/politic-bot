var RSVP = require('rsvp'), fs = require('fs'), Handlebars = require('handlebars');
var PoliticBot = require('./lib/main'), _ = require('underscore');
var snoochives = require('snoochives');
config = require('./config'), pkg = require('./package'), templates = {};
config.userAgent = pkg.name+'/'+pkg.version+' by '+pkg.author;
['mirror', 'report', 'comment'].forEach(function(name) {
  templates[name] = function(ctx) {
    return Handlebars.compile(fs.readFileSync('./templates/'+name+'.md.hbs')+'')(ctx);
  }
});

process.setMaxListeners(1000);

PoliticBot(config, function(bot) {
  bot.data = snoochives(bot.api, 'ingest', {
    t1: {depth: 500000, extra: ['author']},
    t3: {depth: 10000, extra: ['url', 'is_self']}
  }, PoliticBot.schedule);

  return bot.data.promise.then(function() {
    return RSVP.all([
      PoliticBot.otherDiscussions(bot, templates),
      PoliticBot.mirrorTopic(bot),
      PoliticBot.postRemovals(bot, templates),
      PoliticBot.commander(bot, templates).pollForCommands(null, {
        check: function(id) {if (!id) {return;} console.log('check', id);
          if (id.match(/^http/)) {return bot.mirrorUrlNow(id);}
          return bot.byId(id).then(function(post) {
            return bot.mirrorUrl(post.url);
          });
        }
      }),
      PoliticBot.commentRemovals(bot, templates),
      PoliticBot.schedule.repeat(function() {
        if (!Object.keys(bot.updateQueue).length) {return bot.fetchMirrors();} return RSVP.resolve();
      })
    ]);
  });
});
