var fs = require('fs');
var http = require('http');

var multiHashing = require('multi-hashing');

var config = JSON.parse(fs.readFileSync('config.json'));

var cryptoNight = multiHashing['cryptonight'];

var reserveSize = 4;

var diff1 = 0xffffffff;

var connectedMiners = {};



var rpc = function(host, port, method, params, callback){

    var data = JSON.stringify({
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    });

    var options = {
        hostname: config.daemon.host,
        port: config.daemon.port,
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
};

var rpcDaemon = function(method, params, callback){
    rpc(config.daemon.host, config.daemon.port, method, params, callback);
};

var rpcWallet = function(method, params, callback){
    rpc(config.wallet.host, config.wallet.port, method, params, callback);
};


//simplewallet --wallet-file=wallet.bin --pass=test --rpc-bind-port=8082

var getBlockTemplate = function(reserveSize, callback){
    rpcDaemon('getblocktemplate', {reserve_size: reserveSize, wallet_address: config.wallet.address}, callback);
};





function Miner(id, login, pass){
    this.id = id;
    this.login = login;
    this.pass = pass;
    this.heartbeat();
    this.target = config.startingTarget;
}
Miner.prototype = {
    heartbeat: function(){
        this.lastBeat = Date.now();
    },
    getTargetHex: function(){
        var buff = new Buffer(4);
        buff.writeUInt32BE(config.startingTarget, 0);
        var hex = buff.toString('hex');
        return hex;
    }
};

setInterval(function(){
    var now = Date.now();
    var timeout = config.minerTimeout * 1000;
    for (var minerId in connectedMiners){
        if (now - connectedMiners[minerId].lastBeat > timeout){
            delete connectedMiners[minerId];
        }
    }
}, 10000);


var uid = function(){
    var min = 100000000000000;
    var max = 999999999999999;
    var id = Math.floor(Math.random() * (max - min + 1)) + min;
    return id.toString();
};



var CurrentJob = {
    height: 0,
    nextBlob: function(){
        this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
        return this.buffer.toString('hex');
    }
};

var processBlockTemplate = function(template){
    CurrentJob.id = uid();
    CurrentJob.blob = template.blocktemplate_blob;
    CurrentJob.difficulty = template.difficulty;
    CurrentJob.height = template.height;
    CurrentJob.extraNonce = 0;
    CurrentJob.reserveOffset = template.reserved_offset;
    CurrentJob.buffer = new Buffer(CurrentJob.blob, 'hex');
};

var jobRefresh = function(){
    getBlockTemplate(reserveSize, function(error, result){
        if (error){
            console.log('error polling getblocktemplate ' + JSON.stringify(error));
            return;
        }
        if (result.height > CurrentJob.height){
            console.log('found new  block');
            processBlockTemplate(result);
        }
    })
};
jobRefresh();


var processShare = function(miner, nonce, resultHash){
    var shareBuffer = new Buffer(CurrentJob.buffer.length);
    CurrentJob.buffer.copy(shareBuffer);
    shareBuffer.writeUInt32BE(miner.extraNonce, CurrentJob.reserveOffset);
    new Buffer(nonce, 'hex').copy(shareBuffer, 39);

    var hash = cryptoNight(shareBuffer);
    var hashHex = hash.toString('hex');

    if (hashHex !== resultHash) {
        console.log('bad hash ' + hashHex + ' vs ' + resultHash);
        return false;
    }

    var hashTarget = hash.readUInt32LE(hash.length - 4);

    if (hashTarget > miner.target){
        console.log('high target share ' + hashTarget);
        return false;
    }
    console.log('Accepted share ' + resultHash);

    return true;
};


var handleMinerMethod = function(id, method, params, res){

    var sendReply = function(error, result){
        var sendData = JSON.stringify({
            id: id,
            jsonrpc: "2.0",
            error: error ? {code: -1, message: error} : null,
            result: result
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', sendData.length);
        res.end(sendData);
    };

    switch(method){
        case 'login':
            if (!params.login){
                sendReply("missing login");
                return;
            }
            if (!params.pass){
                sendReply("missing pass");
                return;
            }
            var minerId = uid();
            var miner = new Miner(minerId, params.login, params.pass);
            miner.lastJobId = CurrentJob.id;
            miner.extraNonce = CurrentJob.extraNonce;
            connectedMiners[minerId] = miner;
            sendReply(null, {
                id: minerId,
                job: {
                    blob: CurrentJob.nextBlob(),
                    job_id: CurrentJob.id,
                    target: miner.getTargetHex()
                },
                status: 'OK'
            });

            console.log('miner connected ' + params.login + ':' + params.pass);
            break;
        case 'getjob':
            var miner = connectedMiners[params.id];
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            if (miner.lastJobId === CurrentJob.id) {
                sendReply(null, {
                    blob: '',
                    job_id: '',
                    target: ''
                });
                return;
            }
            sendReply(null, {
                blob: CurrentJob.nextBlob(),
                job_id: CurrentJob.id,
                target: miner.getTargetHex()
            });
            miner.lastJobId = CurrentJob.id;
            miner.extraNonce = CurrentJob.extraNonce;
            break;
        case 'submit':
            if (!(params.id in connectedMiners)){
                sendReply('Unauthenticated');
                return;
            }
            if (params.job_id !== CurrentJob.id){
                sendReply('Invalid job id');
                return;
            }

            var shareAccepted = processShare(connectedMiners[params.id], params.nonce, params.result);

            if (!shareAccepted){
                sendReply('Low difficulty share');
                return;
            }

            sendReply(null, {status: 'OK'});
            break;
        default:
            sendReply("invalid method");
            console.log('invalid ' + method + ' ' + JSON.stringify(params));
            break;
    }
};


var getworkServer = http.createServer(function(req, res){
    var data = '';
    req.setEncoding('utf8');
    req.on('data', function(chunk){
        data += chunk;
    });
    req.on('end', function(){
        var jsonData;
        try{
            jsonData = JSON.parse(data);
        }
        catch(e){
            console.log('error parsing json ' + data);
            return;
        }
        if (!jsonData.id || !jsonData.method){
            console.log('miner rpc request missing id or method');
            return;
        }
        handleMinerMethod(jsonData.id, jsonData.method, jsonData.params, res);
    });
});

getworkServer.listen(config.poolPort);