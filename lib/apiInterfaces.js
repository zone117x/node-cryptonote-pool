var http = require('http')

function jsonHttpRequest (host, port, data, callback) {
  var options = {
    hostname: host,
    port: port,
    path: '/json_rpc',
    method: 'POST',
    headers: {
      'Content-Length': data.length,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  }

  var req = http.request(options, function (res) {
    var replyData = ''
    res.setEncoding('utf8')
    res.on('data', function (chunk) {
      replyData += chunk
    })
    res.on('end', function () {
      var replyJson
      try {
        replyJson = JSON.parse(replyData)
      } catch (e) {
        callback(e)
        return
      }
      callback(null, replyJson)
    })
  })

  req.on('error', function (e) {
    callback(e)
  })

  req.end(data)
}

function rpc (host, port, method, params, callback) {
  var data = JSON.stringify({
    id: '0',
    jsonrpc: '2.0',
    method: method,
    params: params
  })
  jsonHttpRequest(host, port, data, function (error, replyJson) {
    if (error) {
      callback(error)
      return
    }
    callback(replyJson.error, replyJson.result)
  })
}

function batchRpc (host, port, array, callback) {
  var rpcArray = []
  for (var i = 0; i < array.length; i++) {
    rpcArray.push({
      id: i.toString(),
      jsonrpc: '2.0',
      method: array[i][0],
      params: array[i][1]
    })
  }
  var data = JSON.stringify(rpcArray)
  jsonHttpRequest(host, port, data, callback)
}

module.exports = function (daemonConfig, walletConfig) {
  return {
    batchRpcDaemon: function (batchArray, callback) {
      batchRpc(daemonConfig.host, daemonConfig.port, batchArray, callback)
    },
    rpcDaemon: function (method, params, callback) {
      rpc(daemonConfig.host, daemonConfig.port, method, params, callback)
    },
    rpcWallet: function (method, params, callback) {
      rpc(walletConfig.host, walletConfig.port, method, params, callback)
    }
  }
}
