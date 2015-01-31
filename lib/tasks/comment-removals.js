var RSVP = require('rsvp'), _ = require('underscore'), schedule = require('../schedule');
module.exports = function(bot, templates) {
  function getId(url) {return url.split('/comments/').pop().split('/')[0];}
  function getCommentId(url) {if (!url) {return;}
    return (url.split('/comments//_/').pop() || '').split('/')[0];
  }
  function getSubreddit(url) {return url.split('/r/').pop().split('/')[0];}
  function inspectComment(comment) {
    if (!comment.link_id) {return;}
    comment.permalink = '/r/' + comment.subreddit + '/comments/' + comment.link_id.split('_').pop() + '/_/' + comment.id;
    if (bot.commentsReported[comment.name]) {return comment;}
    if (_.contains(bot.topicSubs, comment.subreddit.toLowerCase()) || bot.knownUrls[comment.link_url]) {
      if (comment.author === '[deleted]' || !comment.author) {return;}
      bot.knownComments[comment.name] = comment.author;
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
      while (ids.length) {
        tasks.push(byIdTask(ids.splice(0,100)));
      } if (!tasks.length) {return RSVP.resolve([]);}
      return schedule.runInSeries(tasks).then(function() {return _.uniq(_.compact(missing)).filter(function(name) {
        return !bot.commentsReported[name];
      });});
    },
    findRemoved: function(names) {var handled = [];
      return this.findMissing(names).then(function(missing) {handled = missing;
        return this.getFromUserPages(missing);
      }.bind(this)).then(function(removed) {
        handled.forEach(function(j) {delete bot.knownComments[j];});
        return removed;
      });
    },
    getFromUserPages: function(names) {var results = {};
      return RSVP.all(_.compact(_.uniq(names.map(function(j){return bot.knownComments[j];}))).map(function(author) {
        return this.getFromUserPage(author).then(function(comments) {
          comments.forEach(function(j) {if (_.contains(names,j.name)) {results[j.name]=j;}});
        });
      }.bind(this))).then(function() {return _.compact(_.values(results));});
    },
    getFromUserPage: function(author, max) {
      if (!author) {return RSVP.resolve([]);}
      return bot.listing('/user/' + author + '/comments', max).then(function(comments) {
        return _.compact(comments.map(inspectComment));
      }).catch(function(error) {
        console.error(error || error.stack);
        return [];
      });
    },
    reportRemovals: function(removed) {
      var removedByLinkId = _.groupBy(removed, 'link_id');
      return bot.byId(_.keys(removedByLinkId)).then(function(posts) {
        return schedule.runInSeries(posts.map(function(post) {
          return function() {return this.reportForPost(post, removedByLinkId[post.name]);}.bind(this);
        }.bind(this)));
      }.bind(this));
    },
    reportForPost: function(post, removed) {
      var url = bot.baseUrl + post.permalink     
      return bot.submitted(bot.config.commentSubreddit, url).then(function(submitted) {
        if (!submitted.length) {
          return bot.submit({
            kind: 'link',
            sr: bot.config.commentSubreddit,
            title: post.title,
            url: url
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
          var commentReg =  /(?:^###### \[.*?\]\()(.*?)(?:\))/;
          return bot.comments(bot.config.commentSubreddit, mirror.id).then(function(comments) {
            return _.compact(_.where(comments, {author: bot.config.user}).map(function(comment) {
              var match = commentReg.exec(comment.body);
              if (match) {return match[1];}
            }).map(getCommentId));
          }).then(function(commentIds) {
            if (commentIds.length) {console.error('ids', commentIds);}
            return removed = removed.filter(function(j) {return !_.contains(commentIds,j.id);}).filter(function(j) {
              return !bot.commentsReported[j.name];
            });
          }).then(function() {return mirror;});
        });
      }).then(function(mirror) {
        if (!removed.length) {return;}
        return schedule.runInSeries(removed.map(function(comment) {
          return function() {
            return bot.comment(mirror.name, templates.comment(comment)).then(function() {
              bot.commentsReported[comment.name] = true;
            });
          };
        }));
      }).catch(function(error) {console.error('report error', error.stack || error);});
    },
    pollForRemovals: function() {
      return schedule.repeat(function() {
        return this.findRemoved(_.keys(bot.knownComments)).then(this.reportRemovals.bind(this)); 
      }.bind(this));
    },
    pollForComments: function() {
      var users = {};
      return RSVP.all([      
        schedule.repeat(function() {
          return bot.listing('/r/' + bot.config.commentSubreddit + '/hot', 100).then(function(posts) {
            return schedule.runInSeries(posts.map(function(post) {return function() {
              var subreddit = getSubreddit(post.url);
              var id = getId(post.url);
              bot.knownUrls[post.url] = true;
              return bot.comments(subreddit, id).then(function(comments) {
                comments.map(function(j) {users[j.author] = true; return j;}).forEach(inspectComment);
              });
            };}));
          });
        }),
        schedule.repeat(function() {
          var usernames = _.compact(_.without(_.keys(users), '[deleted]'));
          if (!usernames.length) {return RSVP.resolve();}
          return schedule.runInSeries(_.sample(usernames, 10).map(function(user) {
            return function () {return this.getFromUserPage(user);}.bind(this);
          }.bind(this)));
        }.bind(this))
      ]);
    }
  };
};
