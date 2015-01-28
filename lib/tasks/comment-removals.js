var RSVP = require('rsvp'), Nodewhal = require('nodewhal'), _ = require('underscore');
var entities = new (require('html-entities').AllHtmlEntities)();
module.exports = function(bot, templates) {
  return {
    findRemovedByUser: function(username, depth) {
      return bot.listing('/user/' + username + '/comments', {max:depth || 1000}).then(function(results) {
        return Object.keys(results).map(function(key) {return results[key];});
      }).then(function(comments) {
        return comments.map(function(comment) {
          comment.body = entities.decode(comment.body);
          comment.permalink = '/r/' + comment.subreddit + '/comments/' + comment.link_id.split('_').pop() + '/_/' + comment.id;
          return comment;
        });
      }).then(function(allComments) {var removed = {}, tasks = [];
        var ids = _.uniq(_.compact(allComments.map(function(j) {return j.name;})));
        while (ids.length) {
          tasks.push(bot.get(bot.baseUrl + '/api/info.json?id='+ids.splice(0, 100).join(',')).then(function(result) {
            return (((result||{}).data||{}).children||[]).map(function(j) {return j.data;});
          }).then(function(comments) {
            comments.filter(function(j) {return j.author==='[deleted]';}).forEach(function(comment) {
              removed[comment.id] = _.find(allComments, function(j) {return j.id === comment.id});
            });
          }));
        }
        if (!tasks.length) {return [];}
        return RSVP.all(tasks).then(function() {
          return Object.keys(removed).map(function(j) {return removed[j];});
        });
      });
    },
    reportRemoved: function(user, removed, subreddit) {
      if (!removed.length) {return RSVP.resolve();}
      var subs = _.uniq(removed.map(function(j) {return j.subreddit;})).sort();
      var title = 'Detected ' + removed.length + ' comments by ' + user +  ' [removed] from ' + subs.join(', ');
      var body = templates.comments({user: user, removed: removed});
      return bot.submit(subreddit, 'self', entities.decode(title), entities.decode(body));
    },
    checkUser: function(user, subreddit, depth) {
      return this.findRemovedByUser(user, depth).then(function(removed) {
        return this.reportRemoved(user, removed, subreddit);
      }.bind(this));
    }
  };
};
