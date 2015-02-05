var RSVP = require('rsvp'), schedule = require('../schedule');
var _ = require('underscore');
var express = require('express');
var loki = require('lokijs');

function idRange(earliestId, latestId, max) {
  var end = parseInt(latestId+'',36);
  var start = parseInt(earliestId+'',36);
  if (max) {start = end - max;} return _.range(start, end)
    .map(function(j) {return j.toString(36);}).sort().reverse().slice(0,max).sort();
}

module.exports = function(bot) {
  var dbPromise = new RSVP.Promise(function(resolve, reject) {
    bot.ingest = new loki('ingest.json', {
      autoload: true,
      autoloadCallback: function() {resolve(bot.ingest);}
    }); bot.ingest.promise = dbPromise;
  }).then(function() {
    bot.ingest.t1 = bot.ingest.getCollection('t1') || bot.ingest.addCollection('t1');
    bot.ingest.t3 = bot.ingest.getCollection('t3') || bot.ingest.addCollection('t3');
    return bot.ingest;
  });

  function ingestType(type, poll, newItemCb, depth, keys) {var known = {};
    var sorted = _.pluck(bot.ingest[type].find(), 'id').sort();
    var earliest = _.first(sorted);
    var latest = _.last(sorted);
    bot.ingest[type].find().forEach(function(item) {known[item.id] = true;});
    function ingestItem(item) {var data = {};
      if (!item.id) {return;}
      if (known[item.id]) {return item;}
      known[item.id] = true;
      if (!latest || (item.id > latest)) {latest = item.id;}
      if (!earliest || (item.id < earliest)) {earliest = item.id;}
      (keys||[]).concat(['id', 'subreddit', 'created_utc'])
        .forEach(function(key) {data[key] = item[key];});
      bot.ingest[type].insert(data);
      return newItemCb(item);
    }
    var tasks = [schedule.repeat(function() {
      if (!latest || !earliest) {return RSVP.resolve();}
      var existing = idRange(earliest, latest, depth).reverse();
      var missing = existing.filter(function(id) {return !known[id];});
      var names = missing.slice(0, 100).map(function(j) {return type+'_'+j;});
      earliest = _.last(existing);
      bot.ingest[type].find({id: {'$lt':earliest}}).forEach(function(item) {
        bot.ingest[type].remove(item);
      });
      if (!missing.length) {return RSVP.resolve();}
      console.log('range', type, earliest, latest, existing.length, missing.length);
      return bot.byId(names).then(function(items) {items.forEach(ingestItem);
        names.filter(function(j) {return !known[j.split('_').pop()];})
          .forEach(function(name) {known[name.split('_').pop()] = true;});
      });
    })];
    if (poll) {tasks.push(poll(ingestItem));}
    return RSVP.all(tasks);
  }

  var ingest = {clients:  {t1: [], t3: []},
    db: dbPromise,
    newItem: function(item) {
      if (!item || !item.name) {return;}
      var type = item.name.split('_')[0];
      var clients = ingest.clients[type] = ingest.clients[type] || [];
      clients.forEach(function(client) {
        try {client.res.write('data: ' + JSON.stringify(item) + '\n\n');
        } catch(e) {console.error('SSE write error', e.stack || e);}
      });
    },
    comments: function(depth) {
      return ingestType('t1', function(ingestItem) {
        return schedule.repeat(function() {
          return bot.comments().then(function(j) {
            var ids = _.pluck(j, 'id').sort();
            j.forEach(ingestItem);
          });
        });
      }, ingest.newItem, depth, ['link_id', 'author']);
    },
    posts: function(depth) {
      return ingestType('t3', function(ingestItem) {
        return schedule.repeat(function() {
          return bot.listing('/r/all/new', 100).then(function(j) {j.forEach(ingestItem);});
        }, 60000);
      }, ingest.newItem, depth, ['url', 'is_self']);
    },
    eventStream: function(postDepth, commentDepth, port) {
      return dbPromise.then(function() {var app = express();
        function streamEndpoint(clients) {
          return function(req, res) {
            var client = {req: req, res: res}, pingInterval;
            res.writeHead(200, {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Session": "keep-alive"
            });
            res.write('retry: ' + 15000 + '\n');
            clients.push(client);
            pingInterval = setInterval(function() {res.write('\n\n');}, 10000);
            res.on('close', function() {
              if (pingInterval) {clearInterval(pingInterval);}
              var index = clients.indexOf(client);
              if (index !== -1) {clients.splice(index, 1);}
            });
          };
        }
        app.get('/submission_stream', streamEndpoint(ingest.clients.t3));
        app.get('/comment_stream', streamEndpoint(ingest.clients.t1));
        app.listen(port || 4243);
        return app;
      }).then(function() {
        return RSVP.all([
          ingest.posts(postDepth),
          ingest.comments(commentDepth),
          schedule.repeat(function() {
            return new RSVP.Promise(function(resolve, reject) {
              try {bot.ingest.saveDatabase(function(error) {
                if (error) {reject(error);} else {resolve(bot.ingest);}
              });} catch(e) {reject(e);}
            }).catch(function(error) {console.error('error saving persistence', error.stack || errror)});
          }, 60*1000)
        ]);
      });
    }
  };
  return ingest;
}
