var Snoocore = require('snoocore'), EventSource = require('eventsource');
var _ = require('underscore'), RSVP = require('rsvp');
function main(config, botTasks) {
  console.log('\n   ======= ' + config.user + ' | ' + config.userAgent + ' =======\n');
  var api = new Snoocore({
    userAgent: config.userAgent,
    decodeHtmlEntities: true,
    login: {username: config.user, password: config.password},
    oauth: {
      type: 'script',
      duration: 'permanent',
      consumerKey: config.oAuthKey,
      consumerSecret: config.oAuthSecret,
      scope: [
        'edit',
        'read',
        'modflair',
        'flair',
        'history',
        'mysubreddits',
        'privatemessages',
        'read',
        'submit',
        'subscribe',
        'wikiedit',
        'wikiread'
      ]
    }
  });
  api.on('auth_token_expired', function() {
    return api.auth().catch(function(error) {console.error('auth error', error.stack || error);});
  });
  return api.auth().then(function() {
    var bot = {
      api: api,
      config: config,
      baseUrl: 'http://www.reddit.com',
      knownUrls: {},
      reportQueue: {},
      updateQueue: {},
      submissionQueue: [],
      knownPostNames: {},
      
      idListing: function(path, ids) {
        var req = api(path);
        return req.get({id: ids.join(',')}).then(function(result) {
          return (((result||{}).data||{}).children||[]).map(function(j) {return j.data;});
        });
      },
      byId: function(ids) {
        var isSingle = false;
        if (typeof ids == "string") {
          ids = [ids];
          isSingle = true;
        }
        if (!ids.length) {return RSVP.resolve([]);}
        ids = ids.map(function (id) {
          if (id.match(/_/)) {return id;} else {return "t3_" + id;}
        });
        return bot.idListing('/api/info', ids).then(function(results) {
          if (isSingle) {return _.first(results);}
          return results;
        });
      },
      comment: function(name, text) {
        return api('/api/comment').post({api_type: 'json', thing_id: name, text: text});
      },
      duplicates: function(post) {
        return api.raw('http://www.reddit.com'+post.permalink.replace(/\/comments\//, '/duplicates/') + '.json').get(undefined, { bypassAuth: true }).then(function(results) {
          return _.union.apply(_, results.map(function(listing) {
            if (!listing || !listing.data || !listing.data.children) {return [];}
            return listing.data.children.map(function(j) {return j.data;})
          }));
        });
      },
      editusertext: function(name, text) {
        return api('/api/editusertext').post({api_type: 'json', thing_id: name, text: text});
      },
      flair: function(data) {return api('/api/flair').post(data);},
      listing: function(path, max) {
        max = max || 1000;
        return api(path).listing({limit:100}).then(function(slice) {
          var children = [];
          function getNextSlice() {
            if (!slice.children.length) {return RSVP.resolve(children);}
            children = _.union(children, slice.children);
            if (children.length>=max || slice.children.length<100) {return RSVP.resolve(children);}
            return slice.next().then(function(nextSlice) {
              slice = nextSlice; return getNextSlice();
            });
          }
          return getNextSlice().then(function(results) {return results.map(function(j) {return j.data;});});
        });
      },
      comments: function(subreddit, id) {
        return api('/r/'+subreddit+'/comments/'+id).get().then(function(results) {
          if (results && results[1] && results[1].data && results[1].data.children) {
            return results[1].data.children.map(function(j) {return j.data;});
          }
          return [];
        });
      },
      mentions: function() {return bot.listing('/message/mentions', 100);},
      myMultis: function() {return api('/api/multi/mine').get();},
      unreadMessages: function() {return bot.listing('/message/unread', 100);},
      readMessage: function(ids) {
        if (typeof ids == "string") {ids = [ids];}
        return api('/api/read_message').post({api_type: 'json', id: ids.join(',')});
      },
      submit: function(postData) {
        postData.extension = 'json';
        return api('/api/submit').post(postData).then(function(data) {
          if (data && data.json && data.json.errors && data.json.errors.length) {
            throw data.json.errors;
          }
          if (data && data.json && data.json.data) {
            return data.json.data;
          }
          console.log('result', data);
          return data;
        });
      },
      submitted: function(subreddit, url) {
        return api('/r/' + subreddit + '/api/info').get({url:url}).then(function(result) {
          return (((result||{}).data||{}).children||[]).map(function(j) {return j.data;});
        });
      },
      submissionStream: function(url, cb) {
        var es = new EventSource(url);
        es.onmessage = function (e) {
          try {
            cb(JSON.parse(e.data));
          } catch(e) {console.error('stream error', e.stack);}
        }
        return RSVP.resolve(es);
      }
    };
    return botTasks(bot);
  }).catch(function(error) {console.error(error.stack || error);});
};
main.otherDiscussions = require('./tasks/other-discussions');
main.commentRemovals = require('./tasks/comment-removals');
main.postRemovals = require('./tasks/post-removals');
main.mirrorTopic = require('./tasks/mirror-topic');
main.commander = require('./tasks/commander');
main.schedule = require('./schedule');
module.exports = main;
