var RSVP = require('rsvp'), _ = require('underscore'), Nodewhal = require('nodewhal');
module.exports = function(bot, templates) {
  return {
    pollForCommands: function(friendCommands, generalCommands, interval) {
      var friends = [], readMessages = []; interval = interval || 60*1000;

      function doCommand(msg, cmds) {
        var tokens = msg.subject.trim().split();
        var cmdName = tokens[0];
        cmds = cmds || {};
        if (!cmds[cmdName]) {
          console.log('No command: ', cmdName);
          return;
        }
        return RSVP.resolve(cmd[cmdName].apply(msg, tokens.slice(1))).then(function(result) {
          readMessages.push(msg.name); return result;
        });
      }
      function doFriendCommand(msg) {return doCommand(msg, friendCommands);}
      function doGeneralCommand(msg) {return doCommand(msg, generalCommands);}

      return RSVP.all([
        Nodewhal.schedule.repeat(function() {
          return bot.listing('/prefs/friends').then(function(listings) {
            friends = listings.map(function(j) {return j.name});
            console.log('friends', friends);
          });
        }, 10*interval),
        Nodewhal.schedule.repeat(function() {
          return bot.listing('/message/inbox').then(function(messages) {
            return _.compact(messages.map(function(msg) {
              if (_.contains(friends, msg.author)) {return doFriendCommand(msg);}
              return doGeneralCommand(msg);
            }));
          }).then(function(commandTasks) {
            if (commandTasks.length) {return RSVP.all(commandTasks);}
          }).catch(function(error) {console.error(error.stack || error);}).then(function() {
            if (!readMessages.length) {return;}
            return bot.post(bot.baseUrl + '/api/read_message', form: {
              api_type: 'json',
              uh: bot.session.modhash,
              id: readMessages.join(',')
            }).then(function() {readMessages = [];});
          });
        }, interval);
      ]);
    }
  };
}
