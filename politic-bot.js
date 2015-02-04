var RSVP = require('rsvp'), fs = require('fs'), Handlebars = require('handlebars');
var PoliticBot = require('./lib/main'), _ = require('underscore');
config = require('./config'), pkg = require('./package'), templates = {};
config.userAgent = pkg.name+'/'+pkg.version+' by '+pkg.author;
['mirror', 'report', 'comment'].forEach(function(name) {
  templates[name] = function(ctx) {
    return Handlebars.compile(fs.readFileSync('./templates/'+name+'.md.hbs')+'')(ctx);
  }
});

PoliticBot(config, function(bot) {
  var commentRemovals = PoliticBot.commentRemovals(bot, templates);
  var ingest = PoliticBot.ingest(bot);
  return ingest.db.then(function(db) {
    return RSVP.all([
      ingest.eventStream(20000, 200000),
      PoliticBot.otherDiscussions(bot, templates),
      PoliticBot.mirrorTopic(bot),
      PoliticBot.postRemovals(bot, templates),
      PoliticBot.commander(bot, templates).pollForCommands(null, {
        check: function(id) {
          console.log('check', id);
          if (!id) {return;}
          if (id.match(/^http/)) {return bot.submitted(undefined, id).then(_.first).then(bot.mirrorPostNow);}
          return bot.byId(id).then(bot.mirrorPostNow);
        }
      }),
      commentRemovals.pollForComments(),
      commentRemovals.pollForRemovals(),
      commentRemovals.gatherCommentIds(),
      PoliticBot.schedule.repeat(function() {
        if (!Object.keys(bot.updateQueue).length) {return bot.fetchMirrors();} return RSVP.resolve();
      })
    ]);
  });
});
