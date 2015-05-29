var RSVP = require('rsvp'), _ = require('underscore'), schedule = require('../schedule');

module.exports = function(bot, templates, maxCommentDepth) {
  var toReport = {}, urls = {}, reported = {}, subs = {}, posts = {};
  var commentRemovals = {
    getTopicalComments: function() {
      if (!bot.topicSubs.length) {return RSVP.resolve([]);}
      var ids = {}, comments = {};
      return schedule.runInSeries(bot.topicSubs.map(function(subreddit) {
        return function() {
          return bot.data.read(subreddit).then(function(db) {
            db.t3.find().forEach(function(j) {
              if (!j || !j.id) {return;}
              if (!j.is_self && j.url) {urls[j.url] = true};
              ids[j.id] = j.subreddit;
              return j;
            });
          });
        };
      })).then(function() {
        // TODO: iterate across all subs
        return bot.data.getSubs().then(function(subreddits) {
          return _.difference(subreddits, bot.topicSubs.map(function(j) {return j.toLowerCase();}));
        });
      }).then(function(subreddits) {
        return schedule.runInSeries(subreddits.map(function(subreddit) {
          return function() {
            return bot.data.read(subreddit).then(function(db) {
              return db.t3.find().filter(function(post) {return urls[post.url];});
            }).then(function(posts) {
              _.pluck(posts, 'id').forEach(function(id) {ids[id] = subreddit;});
            });
          }
        }));
      }).then(function() {
        return schedule.runInSeries(bot.topicSubs.map(function(subreddit) {
          return function() {subreddit = subreddit.toLowerCase();
            return bot.data.getPostIds(subreddit).then(function(postIds) {
              postIds.forEach(function(id) {ids[id] = subreddit;});
            });
          };
        }));
      }).then(function() {return this.getCommentsForPosts(ids);}.bind(this));
    },
    getCommentsForPosts: function(ids) {
      var comments = {};
      return schedule.runInSeries(_.keys(ids).map(function(id) {
        return function() {
          return bot.data.read(ids[id], id).then(function(db) {
            db.t1.find().forEach(function(comment) {
              if (comment.author === '[deleted]') {return;}
              //if (bot.commentsReported['t1_'+comment.id]) {return;}
              //if (toReport['t1_'+comment.id]) {return;}
              subs['t1_'+comment.id] = ids[id];
              comments['t1_'+comment.id] = comment.author;
              posts['t1_'+comment.id] = id;
            });
          });
        };
      })).then(function() {return comments;});
    },
    checkPosts: function(ids, count) {
      var commentIds;
      return this.getCommentsForPosts(ids).then(function(comments) {
        var keys = _.keys(comments);
        commentIds = keys;
        console.log('comment count', keys.length, count);
        keys.forEach(function(key) {bot.knownComments[key] = comments[key];}); 
        return this.findMissing(keys).then(this.findRemoved.bind(this));
      }.bind(this)).then(this.reportRemovals.bind(this)).then(function(reports) {
        return {
          reports: reports,
          seen: commentIds
        };
      });
    },
    findMissing: function(ids) {var missing = {}, tasks = [];
      function byIdTask(batchIds) {
        return function() {
          return bot.byId(batchIds).then(function(comments) {
            _.pluck(_.where(comments, {author: '[deleted]'}), 'name').map(function(name) {
              missing[name] = true;
            });
          }).catch(function(error) {console.error(error.stack || error);});
        };
      }
      ids = _.uniq(_.compact(ids || []));
      while (ids.length) {tasks.push(byIdTask(ids.splice(0,100)));}
      if (!tasks.length) {return RSVP.resolve([]);}
      return schedule.runInSeries(tasks).then(function() {
        return _.compact(_.keys(missing)).filter(function(name) {
          return !reported[name];
        });
      });
    },
    findRemoved: function(names, depth) {
      names = _.difference(names, _.keys(bot.commentsReported));
      return this.getFromUserPages(names, depth||100, function(item) {
        if (reported[item.name]) {return;}
        toReport[item.name] = item;
      }).then(function(removed) {
        var foundRemoved = {};
        _.pluck(removed, 'name').forEach(function(j) {foundRemoved[j] = true;});
        var deleted = names.filter(function(j) {return !foundRemoved[j];});
        deleted = deleted.map(this.markProcessed.bind(this));
        if (!deleted.length) {return removed;}
        return RSVP.all(deleted).then(function() {return removed;});
      }.bind(this));
    },
    markProcessed: function(name) {
      if (!subs[name] || !posts[name]) {return RSVP.resolve();}
      var id = name.split('_').pop();
      return bot.data.edit(subs[name], posts[name], function(db) {
        var stored = _.first(db.t1.find({id:id}));
        if (stored) {stored.author = '[deleted]';}
      });
    },
    getFromUserPages: function(names, depth, cb) {var results = {};
      var isWanted = {}; names.forEach(function(j) {isWanted[j] = true;});
      if (!names.length) {return RSVP.resolve([]);}
      return schedule.runInSeries(_.compact(_.uniq(names.map(function(j){return bot.knownComments[j];}))).map(function(author) {
        return function() {
          return this.getFromUserPage(author, depth).then(function(comments) {
            return comments.filter(function(j) {return isWanted[j.name];});
          }).then(function(j) {j.forEach(function(k) {
            results[k.name] = k; cb(k);
          });});
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
        }));
      }).catch(function(error) {
        if (!(error + '').match(/404/)) {console.error(error.stack || error); return [];}
        var names = _.compact(_.uniq(_.compact(_.keys(bot.knownComments)).map(function(name) {
          if (bot.knownComments[name] === author) {
            delete bot.knownComments[name];
            reported[name] = true;
            return name;
          }
        }))).map(this.markProcessed.bind(this));
        if (!names) {return;}
        return RSVP.all(names).then(function() {
          return bot.submit({
            kind: 'link',
            sr: bot.config.commentSubreddit,
            title: 'ShadowBan detected: ' + author,
            url: 'http://www.reddit.com/user/' + author,
            sendreplies: false
          }).then(function(banReport) {
            return bot.flair({
              r: bot.config.commentSubreddit,
              link: banReport.name,
              css_class: 'meta',
              text: 'ShadowBan|' + author
            });
          }).catch(function() {}).then(function() {return [];});
        });
      }.bind(this));
    },
    reportRemovals: function(removed) {
      return this.reportToPosts(removed.filter(function(comment) {
        if (
          _.contains(bot.topicSubs, comment.subreddit.toLowerCase()) || urls[comment.link_url] ||
          (comment.body||'').toLowerCase().indexOf(bot.config.user.toLowerCase()) !== -1 ||
          (comment.body||'').toLowerCase().indexOf(bot.config.reportSubreddit.toLowerCase()) !== -1 ||
          (comment.body||'').toLowerCase().indexOf(bot.config.commentSubreddit.toLowerCase()) !== -1
        ) {return true;}
      }));
    },
    reportToPosts: function(removed) {
      var results = [];
      if (!removed.length) {return RSVP.resolve(results);}
      return schedule.runInSeries(removed.map(function(comment) {
        return function() {return this.reportToPost(comment).then(function(report) {
          if (report) {results.push(report);}
        });}.bind(this);
      }.bind(this))).then(function() {return results;});
    },
    reportToPost: function(comment) {
      var url = bot.baseUrl + '/user/' + comment.author + '/comments?limit=1&before=' + (comment.before||'') + '&after=' + (comment.after||'');
      reported[comment.name] = true;
      delete toReport[comment.name];
      var idStr = comment.link_id.split('_').pop() + ':' + comment.id;
      return bot.submitted(bot.config.commentSubreddit, url).then(function(submitted) {
        if (submitted.length) {return submitted;}
        return bot.getRemovedComments([comment.name]).then(function(results) {
          return results;
        }).catch(function(e) {
          console.error('reporting error', e.stack || e);
        });
      }).then(function(submitted) {
        if (submitted.length) {return;}
        var score = comment.score; if (score>0) {score = '+' + score;}
        var title = ([score, 'Comment by', '/u/'+comment.author, '[REMOVED] from', '/r/'+comment.subreddit,
          idStr, comment.body.length, 'characters'
        ].join (' : ').slice(0, 296) + '...');
        return bot.submit({
          kind: 'link',
          sr: bot.config.commentSubreddit,
          title: title,
          url: url,
          sendreplies: false
        }).then(function(j) {return bot.byId(j.name);}).then(function(report) {
          var tasks = [
            bot.flair({
              r: bot.config.commentSubreddit,
              link: report.name,
              css_class: 'meta',
              text: 'r/' + comment.subreddit + '|'+comment.author
            })
          ];
          if (bot.config.reportLiveThread) {
            comment.permalink = 'http://www.reddit.com/r/' + comment.subreddit + '/comments/' + comment.link_id.split('_').pop() + '/_/' + comment.id;
            tasks.push(bot.liveUpdate(
              bot.config.reportLiveThread,
              templates.livecomment({comment: comment, report: report})
            ));
          }
          return RSVP.all(tasks).then(function() {return report;});
        });
      }.bind(this)).then(function(report) {
        return this.markProcessed(comment.name).then(function() {return report;});
      }.bind(this)).catch(function(error) {
        console.error('report error', error.stack || error);
      });
    },
    pollMissing: function(max) {
      return schedule.repeat(function() {
        try {
          return this.getTopicalComments().then(function(comments) {
            bot.knownComments = comments;
            var keys = _.keys(bot.knownComments).sort();
            if (!keys.length) {return RSVP.resolve();}
            console.log('known comments', keys.length);
            if (max) {keys = keys.reverse().slice(0, max).reverse();
            } return this.findMissing(keys).then(this.findRemoved.bind(this));
          }.bind(this)).catch(function(e){console.error(e.stack||e);});
        } catch(e) {
          console.error(e.stack || e);
          return RSVP.resolve();
        }
      }.bind(this));
    },
    pollForRemovals: function(depth) {
      return schedule.wait(30*1000).then(function() {
        /*this.getTopicalComments().then(function(comments) {
          console.log('--------KNOWN COMMENTS', _.keys(comments).length); 
          bot.knownComments = comments;
        });*/
        return RSVP.resolve();
        return RSVP.all([
          this.pollMissing(1000),
          this.pollMissing(10000),
          this.pollMissing(depth),
          schedule.repeat(function(){
            try {
              var items = _.shuffle(_.values(toReport));
              if (!items.length) {return RSVP.resolve();}
              return this.reportRemovals(items).catch(function(e) {
                console.error(e.stack || e);
              });
            } catch (e) {
              console.error('reporting error', e.stack || e);
              return RSVP.resolve();
            }
          }.bind(this))
        ]);
      }.bind(this));
    }
  };
  bot.checkCommentsOnPosts = commentRemovals.checkPosts.bind(commentRemovals);
  return commentRemovals.pollForRemovals(maxCommentDepth);
};
