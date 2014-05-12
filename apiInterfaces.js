var http = require('http');

function httpRequest(host, port, path, data, callback){

}

function rpc(host, port, method, params, callback){

    var data = JSON.stringify({
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    });

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
    };

    var req = http.request(options, function(res){
        var replyData = '';
        res.setEncoding('utf8');
        res.on('data', function(chunk){
            replyData += chunk;
        });
        res.on('end', function(){
            var replyJson;
            try{
                replyJson = JSON.parse(replyData);
            }
            catch(e){
                callback(e);
                return;
            }
            callback(replyJson.error, replyJson.result);
        });
    });

    req.on('error', function(e){
        callback(e);
    });

    req.end(data);
}


module.exports = function(daemonConfig, walletConfig){
    return {
        batchRpcDaemon: function(batchArray, callback){

        },
        rpcDaemon: function(method, params, callback){
            rpc(daemonConfig.host, daemonConfig.port, method, params, callback);
        },
        rpcWallet: function(method, params, callback){
            rpc(walletConfig.host, walletConfig.port, method, params, callback);
        }
    }
};