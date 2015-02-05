var RSVP = require('rsvp'), _ = require('underscore'), schedule = require('../schedule');

module.exports = function(bot, templates) {
  function inspectComment(comment) {
    if (!comment.link_id) {return comment;}
    if (!comment.name && comment.id) {comment.name = 't1_' + comment.id};
    if ((comment.author||'').toLowerCase() === bot.config.user.toLowerCase()) {return comment;};
    comment.permalink = '/r/' + comment.subreddit + '/comments/' + comment.link_id.split('_').pop() + '/_/' + comment.id;
    if (bot.commentsReported[comment.name]) {return comment;}
    if (bot.knownComments[comment.name]) {return comment;}
    if (
      _.contains(bot.topicSubs, comment.subreddit.toLowerCase()) ||
      bot.knownUrls[comment.link_url] ||
      (comment.body||'').toLowerCase().indexOf(bot.config.user.toLowerCase()) !== -1 ||
      (comment.body||'').toLowerCase().indexOf(bot.config.reportSubreddit.toLowerCase()) !== -1 ||
      (comment.body||'').toLowerCase().indexOf(bot.config.commentSubreddit.toLowerCase()) !== -1
    ) {
      bot.knownComments[comment.name] = comment.author;
      return comment;
    }
    return comment;
  }
  var toReport = {};
  return {
    gatherCommentIds: function() {
      return bot.itemStream(bot.commentStreamUrl, inspectComment);
    },
    findMissing: function(ids) {var missing = [], tasks = [];
      function byIdTask(batchIds) {
        return function() {
          return bot.byId(batchIds).then(function(comments) {
            _.pluck(_.where(comments, {author: '[deleted]'}), 'name').map(missing.push.bind(missing));
          }).catch(function(error) {console.error(error.stack || error);});
        };
      }
      ids = _.uniq(_.compact(ids || []));
      console.log('find missing', ids.length);
      while (ids.length) {
        tasks.push(byIdTask(ids.splice(0,100)));
      } if (!tasks.length) {return RSVP.resolve([]);}
      return schedule.runInSeries(tasks).then(function() {return _.uniq(_.compact(missing)).filter(function(name) {
        return !bot.commentsReported[name];
      });});
    },
    findRemoved: function(names, depth) {
      names = _.difference(names, _.keys(bot.commentsReported));
      console.log('find removed', names.length);
      return this.getFromUserPages(names, depth||100, true).then(function(removed) {
        _.difference(names, _.pluck(removed, 'name')).forEach(function(name) {
          bot.commentsReported[name] = true;
        });
        return removed;
      }).then(function(removed) {removed.forEach(function(item) {
        toReport[item.name] = item;
      });});
    },
    getFromUserPages: function(names, depth, queueReport) {var results = {};
      return schedule.runInSeries(_.compact(_.uniq(names.map(function(j){return bot.knownComments[j];}))).map(function(author) {
        console.log('user page', author);
        return function() {
          return this.getFromUserPage(author, depth).then(function(comments) {
            comments = _.compact(comments.map(inspectComment));
            return this.findMissing(_.pluck(comments, 'name')).then(function(ids) {
              comments.forEach(function(j) {if (_.contains(ids,j.name)) {
                if (queueReport) {toReport[j.name] = j} results[j.name]=j;
              }});
            });
          }.bind(this));
        }.bind(this);
      }.bind(this))).then(function() {return _.compact(_.values(results));});
    },
    getFromUserPage: function(author, max) {
      if (!author || author === '[deleted]') {return RSVP.resolve([]);}
      return bot.listing('/user/' + author + '/comments', max).then(function(comments) {
        var after = null;
        return _.compact(comments.map(function(comment) {
          if (after) {
            after.before = comment.name;
            comment.after = after.name;
          }
          after = comment;
          return comment;
        }).map(inspectComment));
      }).catch(function(error) { 
        _.compact(_.keys(bot.knownComments)).forEach(function(name) {
          if (bot.knownComments[name] === author) {delete bot.knownComments[name];}
        });
        console.error(error || error.stack);
        return [];
      });
    },
    reportRemovals: function(removed) {
      return this.reportToPosts(removed.filter(function(comment) {
        if (
          _.contains(bot.topicSubs, comment.subreddit.toLowerCase()) ||
          bot.knownUrls[comment.link_url] ||
          (comment.body||'').toLowerCase().indexOf(bot.config.user.toLowerCase()) !== -1 ||
          (comment.body||'').toLowerCase().indexOf(bot.config.reportSubreddit.toLowerCase()) !== -1 ||
          (comment.body||'').toLowerCase().indexOf(bot.config.commentSubreddit.toLowerCase()) !== -1
        ) {return true;}
      }));
    },
    reportToPosts: function(removed) {
      if (!removed.length) {return RSVP.resolve();}
      return schedule.runInSeries(removed.map(this.reportToPost.bind(this)));
    },
    reportToPost: function(comment) {
      var url = bot.baseUrl + '/user/' + comment.author + '/comments?limit=1&before=' + comment.before + '&after=' + comment.after;
      delete toReport[comment.name];
      return bot.submitted(bot.config.commentSubreddit, url).then(function(submitted) {
        if (!submitted.length) {
          var score = comment.score; if (score>0) {score = '+' + score;}
          return bot.submit({
            kind: 'link',
            sr: bot.config.commentSubreddit,
            title: ([score, 'Comment by', '/u/'+comment.author, '[REMOVED] from', '/r/'+comment.subreddit,
              comment.link_id.split('_').pop() + ':' + comment.id, comment.link_title
            ].join (' : ').slice(0, 296) + '...'),
            url: url,
            sendreplies: false
          });
        }
      }.bind(this)).catch(function(error) {console.error('report error', error.stack || error);});
    },
    pollForComments: function() {
      var self = this; return schedule.repeat(function() {
        return RSVP.resolve(bot.ingest.t1.find().map(inspectComment));
      }, 10000);
    },
    pollMissing: function(max) {
      return schedule.repeat(function() {
        var keys = _.keys(bot.knownComments).sort();
        if (!keys.length) {return RSVP.resolve();}
        if (max) {
          keys = keys.reverse().slice(0, max).reverse();
        } return this.findMissing(keys).then(this.findRemoved.bind(this));
      }.bind(this));
    },
    pollForRemovals: function(depth) {
      return RSVP.all([
        this.pollMissing(depth || 10000),
        schedule.repeat(function(){return this.reportRemovals(_.values(toReport));}.bind(this)),
        schedule.repeat(function(){return RSVP.resolve(bot.ingest.t1.find().map(inspectComment));}, 60*1000)
      ]);
    }
  };
};
