var RSVP = require('rsvp'), fs = require('fs'), Handlebars = require('handlebars');
var PoliticBot = require('./lib/main'), _ = require('underscore');
var snoochives = require('snoochives');
config = require('./config'), pkg = require('./package'), templates = {};
config.userAgent = pkg.name+'/'+pkg.version+' by '+pkg.author;
['mirror', 'report', 'comment', 'livecomment', 'livepost'].forEach(function(name) {
  templates[name] = function(ctx) {
    return Handlebars.compile(fs.readFileSync('./templates/'+name+'.md.hbs')+'')(ctx);
  }
});

var playlist = [
  {
    url: 'https://www.youtube.com/watch?v=VWgsdexkv18&index=10&list=RDp5mmFPyDK_8',
    title: 'Gory Gory What a Helluva Way To Die'
  }
];

var keywords = [
  'pao',
  'kn0thing',
  'fletcher',
  'subredditcancer',
  'fletcher',
  'getfairshare',
  'fairshare',
  'politicbot',
  'moderationlog',
  '美国鬼子',
  'social.justice',
  'sjw',
  'safe.space',
  'safespace',
  '"safe" space',
  'shadowban',
  'moderation',
  'cabal',
  'defaultmods',
  'modtalk',
  'publicmodlogs',
  'modlog.github',
  'modlogs.github',
  'yishan',
  'topmindsofreddit',
  'politicbot',
  'r\/snew',
  'freeze peaches',
  'davidreiss666',
  'ky1e',
  'BritishEnglishPolice',
  '\/oppression'
];

PoliticBot(config, function(bot) {
  bot.data = snoochives(bot.api, 'ingest', {
    t1: {depth: 10000, extra: ['author']},
    t3: {depth: 1000, extra: ['url', 'is_self']}
  }, PoliticBot.schedule);

  bot.data.on('t1', function(item) {
    if (!keywords.filter(function(word) {
      if (item.author === '-moose') {return;}
      if (!!(item.title || '').match(new RegExp(word))) {return true;}
      if (!!(item.link_title || '').match(new RegExp(word))) {return true;}
      if (!!(item.body || '').match(new RegExp(word))) {return true;}
      if (!!(item.author || '').match(new RegExp(word))) {return true;}
    }).length) {return;}

    if (item.parent_id) {
      item.permalink = 'https://www.reddit.com/r/' + item.subreddit + '/comments/' + item.link_id.split('_').pop() + '/_/' + item.id;
    } else {
      item.permalink = 'https://www.reddit.com/r/' + item.subreddit + '/comments/' + item.name + '/_/';
    }

    var maosig = [
      "---",
      "> [What is the sound of one hand clapping?](https://www.youtube.com/watch?v=TQ7qLwVL7CA)",
      "# [—  文革中的机器毛 ಠ_ಠ](/u/go1dfish/m/readme)",
      "    Would you like to play another game?",
      "**/r/redditpolicy /r/bringbackreddit or /r/GASTHESNOO**",
      "# [WE SHALL OVERCOME!](https://www.youtube.com/watch?v=IzRhFH5OyHo&list=RDp5mmFPyDK_8&index=5) - [美国鬼子ಠ_ಠ](https://zh.reddit.com/r/POLITIC/comments/37ovia/politicbot_was_shadowbanned_yesterday_for_spam/)"
    ].join('\n\n');

    bot.liveUpdate(
      'uocz16gmx2s7',
      [
        '[From](' + 'https://zh.reddit.com/api/info?id=' + item.name + '): /u/' + item.author + ' /r/' + item.subreddit,
        item.permalink,
        maosig
      ].join('\n\n')
    );
  });
});
