var Nodewhal = require('nodewhal');
function main(config, botTasks) {
  console.log('\n   ======= ' + config.user + ' | ' + config.userAgent + ' =======\n');
  return Nodewhal(cfg.userAgent).login(config.user, config.password).then(function(bot) {
    bot.config = config; return botTasks(bot);
  }).catch(function(error) {console.error(error.stack || error);});
};
main.otherDiscussions = require('./tasks/other-discussions');
main.commentRemovals = require('./tasks/comment-removals');
main.mirrorTopic = require('./tasks/mirror-topic');
main.commander = require('./tasks/commander');
module.exports = main;
