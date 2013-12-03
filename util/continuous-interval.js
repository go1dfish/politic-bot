function continuousInterval(promiseFunc, interval)  {
  var promise = promiseFunc.call();
  if (interval) {
    promise.then(function() {
      setTimeout(function() {
        continuousInterval(promiseFunc, interval);
      }, interval);
    }, function(error) {
      console.error(error, error.stack);
      setTimeout(function() {
        continuousInterval(promiseFunc, interval);
      }, interval);
    });
  }
  return promise;
}

module.exports = continuousInterval
