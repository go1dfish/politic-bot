var Snoocore = require('snoocore'), EventSource = require('eventsource');
var request = require('superagent');
var _ = require('underscore'), RSVP = require('rsvp');
//require('longjohn');

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
  api.on('access_token_expired', wrap(function() {
    return api.auth().catch(function(error) {console.error('auth error', error.stack || error);});
  }));
  function wrap(f) {
    return function() {   
      var args = arguments;
      var self = this;
      return main.schedule.retry(function() {
        return f.apply(self, args);
      }, function(err) {
        if ((err + "").match(/(Too slow|TIMEDOUT)/i)) {
          console.error('retry', err.stack||err);
          return true;
        }
      });
    };
  }
  return api.auth().then(function() {
    var bot = {
      wrap: wrap,
      api: api,
      config: config,
      baseUrl: 'http://www.reddit.com',
      postStreamUrl: "http://localhost:4243/submission_stream?eventsource=true",
      commentStreamUrl: "http://localhost:4243/comment_stream?eventsource=true",
      topicSubs: [],
      knownUrls: {},
      knownPosts: {},
      knownComments: {},
      commentsReported: {},
      reportQueue: {},
      updateQueue: {},
      submissionQueue: [],
      knownPostNames: {},
      ingest: {
        t1: {},
        t3: {}
      },
      fetchRAData: wrap(function(url) {
        return (new RSVP.Promise(function(resolve, reject) {
          console.log('RA', url);
          request.get(url)
            .set('Accept', 'application/json')
            .end(function(error, res) {
              if (error) {
                reject(error);
              } else {
                resolve(res)
              }
            });
        })).then(function(response) {
          if (!response.body.data) {return [];}
          return response.body.data.reverse();
        });
      }),
      idListing: wrap(function(path, ids) {
        var req = api(path);
        return req.get({id: ids.join(',')}).then(function(result) {
          return (((result||{}).data||{}).children||[]).map(function(j) {return j.data;});
        });
      }),
      byId: wrap(function(ids) {
        var isSingle = false;
        if (typeof ids == "string") {
          ids = [ids];
          isSingle = true;
        }
        if (!ids || !ids.length) {return RSVP.resolve([]);}
        ids = ids.map(function (id) {
          if (id.match(/_/)) {return id;} else {return "t3_" + id;}
        }).sort();
        return bot.idListing('/api/info', ids).then(function(results) {
          results.forEach(function(item) {
            if (item && item.url && item.url.replace) {
              item.url = item.url.replace('oauth.reddit.com', 'www.reddit.com');
            }
          });
          if (isSingle) {return _.first(results);}
          return results;
        });
      }),
      comment: wrap(function(name, text) {
        console.log('COMMENT', name, '\n' + text);
        return api('/api/comment').post({api_type: 'json', thing_id: name, text: text});
      }),
      duplicates: wrap(function(post) {
        //return api('/r/' + post.subreddit + '/duplicates/' + post.id).get(undefined, { bypassAuth: true }).then(function(results) {
        console.log('DUPLICATES', post.permalink);
        return RSVP.resolve().then(function() {
          return api.raw('http://www.reddit.com'+post.permalink.replace(/\/comments\//, '/duplicates/') + '.json')
              .get({limit:100}, { bypassAuth: true }).then(function(results) {
            return _.union.apply(_, results.map(function(listing) {
              if (!listing || !listing.data || !listing.data.children) {return [];}
              return listing.data.children.map(function(j) {return j.data;})
            }));
          });
        }).then(function(results) {
          return results;
        });
      }),
      editusertext: wrap(function(name, text) {
        console.log('EDITUSERTEXT', name, '\n' + text);
        return api('/api/editusertext').post({api_type: 'json', thing_id: name, text: text});
      }),
      flair: wrap(function(data) {
        console.log('FLAIR', JSON.stringify(data));
        return api('/api/flair').post(data);
      }),
      listing: wrap(function(path, max, opts) {
        max = max || 1000;
        opts = opts || {};
        opts.limit = 100;
        console.log('LISTING', path);
        return api(path).listing(opts).then(function(slice) {
          var children = [];
          var getNextSlice = wrap(function() {
            if (!slice.children.length) {return RSVP.resolve(children);}
            children = _.union(children, slice.children);
            if (children.length>=max || slice.empty) {return RSVP.resolve(children);}
            return slice.next().then(function(nextSlice) {
              slice = nextSlice; return getNextSlice();
            });
          })
          return getNextSlice().then(function(results) {return results.map(function(j) {return j.data;});});
        });
      }),
      comments: wrap(function(subreddit, id) {
        var url = '/comments/';
        if (subreddit) {url = '/r/' + subreddit + url;}
        if (id) {url = url + id;}
        console.log('COMMENTS', url);
        return api(url).get().then(function(results) {
          if (results && results[1] && results[1].data && results[1].data.children) {
            return results[1].data.children.map(function(j) {return j.data;});
          } else if (results.data && results.data.children) {
            return _.pluck(results.data.children, 'data');
          }
          return [];
        });
      }),
      mentions: function() {return bot.listing('/message/mentions', 100);},
      myMultis: wrap(function() {return api('/api/multi/mine').get();}),
      unreadMessages: function() {return bot.listing('/message/unread', 100);},
      readMessage: wrap(function(ids) {
        if (typeof ids == "string") {ids = [ids];}
        return api('/api/read_message').post({api_type: 'json', id: ids.join(',')});
      }),
      submit: wrap(function(postData) {
        console.log('SUBMIT', JSON.stringify(postData));
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
      }),
      submitted: wrap(function(subreddit, url) {
        var path = '/api/info';
        if (subreddit) {path = '/r/' + subreddit + path;}
        return api(path).get({url:url}).then(function(result) {
          return (((result||{}).data||{}).children||[]).map(function(j) {return j.data;});
        });
      }),
      itemStream: wrap(function(url, cb) {
        var es = new EventSource(url);
        es.onmessage = function (e) {
          try {
            cb(JSON.parse(e.data));
          } catch(e) {console.error('stream error', e.stack);}
        }
        return RSVP.resolve(es);
      })
    };
    return botTasks(bot);
  }).catch(function(error) {console.error(error.stack || error);});
};
main.ingest = require('./tasks/ingest');
main.otherDiscussions = require('./tasks/other-discussions');
main.commentRemovals = require('./tasks/comment-removals');
main.postRemovals = require('./tasks/post-removals');
main.mirrorTopic = require('./tasks/mirror-topic');
main.commander = require('./tasks/commander');
main.schedule = require('./schedule');
module.exports = main;
