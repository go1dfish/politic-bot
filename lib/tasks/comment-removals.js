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
      return this.getFromUserPages(names, depth||100).then(function(removed) {
        _.difference(names, _.pluck(removed, 'name')).forEach(function(name) {
          bot.commentsReported[name] = true;
        });
        return removed;
      });
    },
    getFromUserPages: function(names, depth) {var results = {};
      return schedule.runInSeries(_.compact(_.uniq(names.map(function(j){return bot.knownComments[j];}))).map(function(author) {
        console.log('user page', author);
        return function() {
          return this.getFromUserPage(author, depth).then(function(comments) {
            comments = _.compact(comments.map(inspectComment));
            return this.findMissing(_.pluck(comments, 'name')).then(function(ids) {
              comments.forEach(function(j) {if (_.contains(ids,j.name)) {results[j.name]=j;}});
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
      console.log('removed', removed.length);
      removed = removed.filter(function(comment) {
        if (
          _.contains(bot.topicSubs, comment.subreddit.toLowerCase()) ||
          bot.knownUrls[comment.link_url] ||
          (comment.body||'').toLowerCase().indexOf(bot.config.user.toLowerCase()) !== -1 ||
          (comment.body||'').toLowerCase().indexOf(bot.config.reportSubreddit.toLowerCase()) !== -1 ||
          (comment.body||'').toLowerCase().indexOf(bot.config.commentSubreddit.toLowerCase()) !== -1
        ) {return true;}
      });
      var removedByLinkId = _.groupBy(removed, 'link_id');
      var authors = _.compact(_.uniq(_.pluck(removed, 'author')));
      if (!removed.length || !authors.length) {return RSVP.resolve();}
      return RSVP.all([
        bot.byId(_.keys(removedByLinkId)).then(function(posts) {
          return schedule.runInSeries(posts.map(function(post) {
            return function() {return this.reportForPost(post, removedByLinkId[post.name]);}.bind(this);
          }.bind(this)));
        }.bind(this)),
        authors.map(function(author) {return this.reportForUser(author, removed);}.bind(this))
      ]);
    },
    reportForPost: function(post, removed) {
      var url = bot.baseUrl + post.permalink
      var postedComments = [];
      if (!removed.length) {return RSVP.resolve();}
      return bot.submitted(bot.config.commentSubreddit, url).then(function(submitted) {
        if (!submitted.length) {
          return bot.submit({
            kind: 'link',
            sr: bot.config.commentSubreddit,
            title: post.title,
            url: url,
            sendreplies: false
          }).then(function(mirror) {
            return bot.flair({
              r: bot.config.commentSubreddit,
              link: mirror.name,
              css_class: 'meta',
              text: 'r/' + post.subreddit
            }).then(function() {return mirror;});
          });
        }
        return RSVP.resolve(_.first(submitted)).then(function(mirror) {
          return bot.comments(bot.config.commentSubreddit, mirror.id).then(function(j) {
            postedComments = j; return mirror;
          });
        });
      }).then(function(mirror) {
        return this.reportRemovedComments(mirror, postedComments, removed);
      }.bind(this)).catch(function(error) {console.error('report error', error.stack || error);});
    },
    reportForUser: function(user, removed) {
      var url = bot.baseUrl + '/user/' + user;
      var postedComments = [];
      removed = _.where(removed, {author: user});
      if (!removed.length) {return RSVP.resolve();}
      return bot.submitted(bot.config.userSubreddit, url).then(function(submitted) {
        if (!submitted.length) {
          return bot.submit({
            kind: 'link',
            sr: bot.config.userSubreddit,
            title:'/u/' + user,
            url: url,
            sendreplies: false
          });
        }
        return RSVP.resolve(_.first(submitted)).then(function(mirror) {
          return bot.comments(bot.config.userSubreddit, mirror.id).then(function(j) {
            postedComments = j; return mirror;
          }).catch(function(e) {console.error(e||e.stack); return mirror;});
        });
      }).then(function(mirror) {
        return this.reportRemovedComments(mirror, postedComments, removed);
      }.bind(this)).catch(function(error) {console.error('report error', error.stack || error);});
    },
    reportRemovedComments: function(mirror, comments, removed) {
      return schedule.runInSeries(removed.map(function(comment) {
        var body = templates.comment(comment);
        if (_.first(comments.filter(function(j) {
          return (j.body||'').indexOf(comment.permalink) !== -1;
        }))) {return RSVP.resolve();}
        return function() {
          return bot.comment(mirror.name, body).then(function() {
            bot.commentsReported[comment.name] = true;
          });
        };
      }));
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
        }
        return this.findMissing(keys).then(
          this.findRemoved.bind(this)
        ).then(this.reportRemovals.bind(this));
      }.bind(this));
    },
    pollForRemovals: function() {
      return RSVP.all([
        this.pollMissing(10000)
      ]);
    }
  };
};
