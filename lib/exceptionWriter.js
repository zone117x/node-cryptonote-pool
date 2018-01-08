/* global config */

var fs = require('fs')
var cluster = require('cluster')

var dateFormat = require('dateformat')

module.exports = function (logSystem) {
  process.on('uncaughtException', function (err) {
    console.log('\n' + err.stack + '\n')
    var time = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss')
    fs.appendFile(config.logging.files.directory + '/' + logSystem + '_crash.log', time + '\n' + err.stack + '\n\n', function () {
      if (cluster.isWorker) { process.exit() }
    })
  })
}
