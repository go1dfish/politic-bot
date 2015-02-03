var RSVP = require('rsvp'), schedule = require('../schedule');
var _ = require('underscore');
var request = require('superagent');
var express = require('express');

function idRange(earliestId, latestId, max) {
  var end = parseInt(latestId+'',36);
  var start = parseInt(earliestId+'',36);
  if (max) {
    start = end - max; //start = _.max([(end-max), start]);
  }
  var ids = _.range(start, end).map(function(j) {return j.toString(36);});
  return ids.reverse().slice(0,max).sort();
}

module.exports = function(bot) {
  function ingestType(type, val, poll, newItemCb, depth) {
    var earliest, latest;
    function ingestItem(item) {if (!item.id) {return;}
      if (_.has(bot.ingest[type], item.id)) {return;}
      bot.ingest[type][item.id] = item[val];
      if (!latest || (item.id > latest)) {latest = item.id;}
      if (!earliest || (item.id < earliest)) {earliest = item.id;}
      return newItemCb(item);
    }
    var tasks = [schedule.repeat(function() {
      if (!latest || !earliest) {return RSVP.resolve();}
      var existing = idRange(earliest, latest, depth);
      var missing = existing.filter(function(id) {return !_.has(bot.ingest[type],id)});
      var names = missing.slice(0, 100).map(function(j) {return type+'_'+j;});
      if (!missing.length) {return RSVP.resolve();}
      console.log('range', type, earliest, latest, existing.length, missing.length);
      return bot.byId(names).then(function(items) {
        items.forEach(ingestItem);
        names.filter(function(j) {
          return !_.has(bot.ingest[type],j.split('_').pop());
        }).forEach(function(name) {
          bot.ingest[type][name.split('_').pop()] = false;
          console.log('unretrievable', name);
        });
      });
    })];
    if (poll) {tasks.push(poll(ingestItem));}
    return RSVP.all(tasks);
  }

  var ingest = {
    clients:  {t1: [], t3: []},
    newItem: function(item) {
      if (!item || !item.name) {return;}
      var type = item.name.split('_')[0];
      var clients = ingest.clients[type] = ingest.clients[type] || [];
      clients.forEach(function(client) {
        try {
          client.res.write('data: ' + JSON.stringify(item) + '\n\n');
        } catch(e) {
          console.error('SSE write error', e.stack || e);
        }
      });
    },
    comments: function() {
      return ingestType('t1', 'author', function(ingestItem) {
        return schedule.repeat(function() {
          return bot.comments().then(function(items) {
            return items.forEach(ingestItem);
          });
        });
      }, ingest.newItem, 100000);
    },
    posts: function() {
      return ingestType('t3', 'subreddit', function(ingestItem) {
        return schedule.repeat(function() {
          return bot.listing('/r/all/new', 100).then(function(items) {
            return items.forEach(ingestItem);
          });
        });
      }, ingest.newItem, 10000);
    },
    eventStream: function(port) {
      return new RSVP.Promise(function(resolve, reject) {
        var app = express();
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
        resolve(app);
      }).then(function() {
        return RSVP.all([
          ingest.posts(),
          ingest.comments()
        ]);
      });
    }
  };
  return ingest;
}
