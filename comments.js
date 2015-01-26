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
      }).then(function(allComments) {var removed = {};
        return RSVP.all(allComments.map(function(cmt) {
          return bot.comments(cmt.permalink).then(function(comments) {
            return comments.map(function(j) {return j.data;});
          }).then(function(comments) {
            comments.filter(function(comment) {
              return comment.author === '[deleted]' && comment.id === cmt.id;
            }).forEach(function(comment) {removed[comment.id] = cmt;});
          }, function(error) {console.error(error.stack || error);});
        })).then(function() {
          return Object.keys(removed).map(function(j) {return removed[j];});
        });
      });
    },
    reportRemoved: function(user, removed, subreddit) {
      if (!removed.length) {return RSVP.resolve();}
      var subs = _.uniq(removed.map(function(j) {return j.subreddit;})).sort();
      var title = removed.length + ' comments by ' + user +  ' removed from ' + subs.join(', ');
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
