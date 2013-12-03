var request = require('request'),
    lastRedditRequestTimeByUrl = {},
    lastRedditRequestTime;

function redditReq(url) {
  try {
    var now = new Date(),
        args = arguments,
        minInterval = 2100,
        minUrlInterval = 30100,
        lastUrlInterval,
        lastUrlTime = lastRedditRequestTimeByUrl[url],
        interval = now - lastRedditRequestTime;
    if (lastUrlTime) {
      lastUrlInterval = now - lastUrlTime;
    }
    if (lastRedditRequestTime && interval < minInterval) {
      setTimeout(function() {
        redditReq.apply(this, args);
      }, minInterval - interval + 100, arguments);
    } else {
      if (lastUrlInterval && lastUrlInterval < minUrlInterval) {
        setTimeout(function() {
          redditReq.apply(this, args);
        }, minUrlInterval - lastUrlInterval + 100, arguments);
      } else {
        lastRedditRequestTime = now;
        lastRedditRequestTimeByUrl[url] = now;
        //console.log('requesting', url);
        request.apply(this, arguments);
      }
    }
  } catch(e) {
    console.error('redditReq', e, e.stack);
  }
}

module.exports = redditReq;
