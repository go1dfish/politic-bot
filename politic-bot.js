var EventSource = require('eventsource'),
    couchbase   = require('couchbase'),
    RSVP        = require('rsvp'),
    subreddits  = [
      'Politics', 'WorldNews', 'Canada', 'CanadaPolitics', 'Communism', 'News',
      'Obama', 'evolutionReddit', 'Liberal', 'Progressive', 'Conservative',
      'conservatives', 'Democrats', 'Republican', 'Libertarian', 'LibertarianLeft',
      'ModeratePolitics', 'Anarchism', 'Bad_Cop_No_Donut', 'RonPaul', 'Conspiracy',
      'PoliticalDiscussion', 'PoliticalHumor', 'AnythingGoesNews',
      'AnythingGoesPolitics', 'Socialism', 'Wikileaks', 'WorldEvents', 'WorldPolitics',
      'SOPA', 'StateoftheUnion', 'USPolitics', 'UKPolitics', 'Anarcho_Capitalism',
      'Economy', 'Economics', 'DarkNetPlan', 'MensRights', 'WomensRights'
    ],
    submissionEventSource;

connectToCouchbase({bucket: 'reddit-submissions'}).then(function(cb) {
  try {
    persistIncommingSubmissions(cb, 'http://api.rednit.com/submission_stream?eventsource=true&subreddit=' + subreddits.join('+'));
  } catch(error) {
    console.error('Submission stream error', error, error.stack);
  }
}, function(error) {
  console.error('Error connecting to couchbase', error);
});

function connectToCouchbase(args) {
  return RSVP.Promise(function(resolve, reject) {
    var cb = new couchbase.Connection(args, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(cb);
      }
    });
  });
}

function persist(cb, key, value) {
  return RSVP.Promise(function(resolve, reject) {
    cb.set(key, value, function(error) {
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    });
  });
}

function persistIncommingSubmissions(cb, url) {
  var eventSource = new EventSource(url);
  eventSource.onmessage = function(evt) {
    try {
      var data = JSON.parse(evt.data);
      persist(cb, data.name, data).then(function() {
        console.log('New Submission', data.name, data);
      }, function(err) {
        console.error('Error persisting', err);
      });
    } catch(error) {
      console.error(error, error.stack);
    }
  };
  eventSource.onerror = function(error) {
    console.error("Submission EventSource error", error);
  }
  return eventSource;
}
