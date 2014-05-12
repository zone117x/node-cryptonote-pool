var fs = require('fs');
var http = require('http');

var bignum = require('bignum');
var redis = require('redis');
var multiHashing = require('multi-hashing');

var config = JSON.parse(fs.readFileSync('config.json'));

var logger = require('./logUtil.js')({
    logLevel: config.logLevel,
    logColors: config.logColors
});

var logSubSystem = 'Thread ' + (parseInt(process.env.forkId) + 1);


function log(severity, component, message){
    logger[severity]('Pool', logSubSystem, component, message);
}



var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);
var utils = require('./utils.js');

var redisClient = redis.createClient(config.redis.port, config.redis.host);


var cryptoNight = multiHashing['cryptonight'];

var diff1 = bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);

var connectedMiners = {};

/* Every 10 seconds clear out timed-out miners */
setInterval(function(){
    var now = Date.now();
    var timeout = config.minerTimeout * 1000;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if (now - miner.lastBeat > timeout){
            log('debug', 'Miner Cleaner', 'Disconnected miner ' + miner.login);
            delete connectedMiners[minerId];
        }
    }
}, 10000);



var CurrentJob = {
    height: 0,
    nextBlob: function(){
        this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
        return this.buffer.toString('hex');
    }
};


var VarDiff = (function(){
    var variance = config.varDiff.variancePercent / 100 * config.varDiff.targetTime;
    return {
        variance: variance,
        bufferSize: config.varDiff.retargetTime / config.varDiff.targetTime * 4,
        tMin: config.varDiff.targetTime - variance,
        tMax: config.varDiff.targetTime + variance
    };
})();


(function init(){
    jobRefresh(function(sucessful){
        if (!sucessful){
            log('error', 'Could not start pool');
            return;
        }
        startPoolServer(function(sucessful){
           if (!sucessful)
               log('error', 'Could not start pool');
        });
    });
})();


function Miner(id, login, pass, ip){
    this.id = id;
    this.login = login;
    this.pass = pass;
    this.ip = ip;
    this.heartbeat();
    this.difficulty = config.difficulty;
}
Miner.prototype = {
    heartbeat: function(){
        this.lastBeat = Date.now();
    },
    getTargetHex: function(){
        if (this.pendingDifficulty){
            this.lastDifficulty = this.difficulty;
            this.difficulty = this.pendingDifficulty;
            this.pendingDifficulty = null;
        }
        var buff = diff1.div(this.difficulty).toBuffer().slice(0, 4);
        var buffArray = buff.toJSON();
        buffArray.reverse();
        buff = new Buffer(buffArray);
        this.target = buff.readUInt32LE(0);
        var hex = buff.toString('hex');
        return hex;
    },
    getJob: function(){
        if (this.lastJobId === CurrentJob.id && !this.pendingDifficulty) {
            return {
                blob: '',
                job_id: '',
                target: ''
            };
        }

        var newJob = {
            blob: CurrentJob.nextBlob(),
            job_id: CurrentJob.id,
            target: this.getTargetHex()
        };

        this.lastJobId = CurrentJob.id;
        this.extraNonce = CurrentJob.extraNonce;
        return newJob;

    },
    retarget: function(){

        var options = config.varDiff;

        var ts = (Date.now() / 1000) | 0;
        if (!this.lastRtc){
            this.lastRtc = ts - options.retargetTime / 2;
            this.lastTs = ts;
            this.timeBuffer = utils.ringBuffer(VarDiff.bufferSize);
            return;
        }
        var sinceLast = ts - this.lastTs;
        this.timeBuffer.append(sinceLast);
        this.lastTs = ts;

        if ((ts - this.lastRtc) < options.retargetTime && this.timeBuffer.size() > 0)
            return;

        this.lastRtc = ts;
        var avg = this.timeBuffer.avg();
        var ddiff = options.targetTime / avg;

        if (avg > VarDiff.tMax && this.difficulty > options.minDiff) {
            if (ddiff * this.difficulty < options.minDiff){
                ddiff = options.minDiff / this.difficulty;
            }
        }
        else if (avg < VarDiff.tMin){
            if (ddiff * this.difficulty > options.maxDiff){
                ddiff = options.maxDiff / this.difficulty;
            }
        }
        else
            return;

        var newDiff = Math.round(this.difficulty * ddiff);
        this.timeBuffer.clear();
        log('debug', 'Difficulty Retargeter', 'Retargetting difficulty ' + this.difficulty + ' to ' + newDiff +' for ' + this.login);
        this.pendingDifficulty = newDiff;
    }
};





function getBlockTemplate(callback){
    apiInterfaces.rpcDaemon('getblocktemplate', {reserve_size: 4, wallet_address: config.wallet.address}, callback);
}



function processBlockTemplate(template){
    CurrentJob.id = utils.uid();
    CurrentJob.blob = template.blocktemplate_blob;
    CurrentJob.difficulty = template.difficulty;
    CurrentJob.height = template.height;
    CurrentJob.extraNonce = 0;
    CurrentJob.reserveOffset = template.reserved_offset;
    CurrentJob.buffer = new Buffer(CurrentJob.blob, 'hex');

    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if (miner.longPoll){
            log('debug', 'Long Polling', 'Sending new job to miner');
            clearInterval(miner.longPoll.timeout);
            miner.longPoll.reply(null, {
                blob: CurrentJob.nextBlob(),
                job_id: CurrentJob.id,
                target: miner.getTargetHex()
            });
            miner.lastJobId = CurrentJob.id;
            miner.extraNonce = CurrentJob.extraNonce;
            delete miner.longPoll;
        }
    }

}

function jobRefresh(callback){
    callback = callback || function(){};
    getBlockTemplate(function(error, result){
        if (error){
            log('error', 'Job Refresher', 'Error polling getblocktemplate ' + JSON.stringify(error));
            callback(false);
            return;
        }
        if (result.height > CurrentJob.height){
            log('debug', 'Job Refresher', 'Found new block at height ' + result.height + ' w/ difficulty of ' + result.difficulty);
            processBlockTemplate(result);
        }
        setTimeout(jobRefresh, config.blockRefreshInterval);
        callback(true);
    })
}

function recordShareData(miner, difficulty){

    var dateNow = Date.now();

    redisClient.multi([
        ['hincrby', config.coin + ':sharesHeight' + CurrentJob.height, miner.login, difficulty],
        ['zadd', config.coin + ':hashrate', dateNow / 1000 | 0, [difficulty, miner.login, dateNow].join(':')]
    ]).exec(function(err, resplies){
        if (err){
            log('error', 'Redis Writer', 'Failed to insert share into redis ' + JSON.string(err));
        }
    });

}

function processShare(miner, nonce, resultHash){
    var shareBuffer = new Buffer(CurrentJob.buffer.length);
    CurrentJob.buffer.copy(shareBuffer);
    shareBuffer.writeUInt32BE(miner.extraNonce, CurrentJob.reserveOffset);
    new Buffer(nonce, 'hex').copy(shareBuffer, 39);

    var hash = cryptoNight(shareBuffer);
    var hashHex = hash.toString('hex');

    if (hashHex !== resultHash) {
        log('error', 'Share Validator', 'Bad hash from miner ' + miner.login + '@' + miner.ip);
        return false;
    }

    var hashArray = hash.toJSON();
    hashArray.reverse();
    var hashNum = bignum.fromBuffer(new Buffer(hashArray));
    var hashDiff = diff1.div(hashNum);

    if (hashDiff.ge(CurrentJob.difficulty)){
        log('special', 'Share Validator', 'Block found at height ' + CurrentJob.height + ' by miner ' + miner.login + '@' + miner.ip)
        apiInterfaces.rpcDaemon('submitblock', [hashHex], function(error, result){
            if (error){
                log('error', 'Share Validator', 'Error submitting block ' + JSON.stringify(error));
            }
        });
        redisClient.lpush(config.coin + ':blocksPending', [CurrentJob.height, CurrentJob.difficulty, hashHex].join(':'), function(error){
            log('error', 'Redis Writer', 'Error inserting block into redis ' + JSON.stringify(error));
        });
    }

    var diffAccepted = miner.difficulty;

    if (hashDiff.lt(miner.difficulty)){

        if (!miner.lastDifficulty || hashDiff.lt(miner.lastDifficulty)){
            log('error', 'Share Validator', 'Rejected low difficulty share of ' + hashDiff.toString());
            return false;
        }
        else
            diffAccepted = miner.lastDifficulty;

    }

    /*var hashTarget = hash.readUInt32LE(hash.length - 4);
    var percent = (miner.target / hashTarget * 100).toFixed(2);

    if (hashTarget > miner.target){
        log('error', 'Share Validator', 'Rejected high share target - ' + percent + '% of target (' + miner.target + '/' + hashTarget + ')');
        return false;
    }
    log('debug', 'Share Validator', 'Accepted share at difficulty ' + hashDiff.toString() + ' - ' + percent + '% of target (' + miner.target + '/' + hashTarget + ')');
    */

    log('debug', 'Share Validator', 'Accepted share at difficulty ' + diffAccepted + '/' + hashDiff.toString() + ' from ' + miner.login + '@' + miner.ip);

    recordShareData(miner, diffAccepted);

    return true;
}


function handleMinerMethod(id, method, params, req, res){

    var componentName = 'RPC Handler';

    var miner = connectedMiners[params.id];

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

    res.on('close', function(){
        sendReply = function(){
            log('debug', componentName, 'Tried sending data to an abruptly disconnected miner');
        };
    });

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
            var minerId = utils.uid();
            miner = new Miner(minerId, params.login, params.pass, req.connection.remoteAddress);
            connectedMiners[minerId] = miner;
            sendReply(null, {
                id: minerId,
                job: miner.getJob(),
                status: 'OK'
            });
            log('debug', componentName, 'Miner connected ' + params.login + '@' + miner.ip);
            break;
        case 'getjob':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            if (!config.useLongPolling){
                sendReply(null, miner.getJob());
                return;
            }
            miner.longPoll = {
                timeout: setTimeout(function(){
                    delete miner.longPoll;
                    sendReply(null, miner.getJob());
                }, 5000),
                reply: sendReply
            };
            return;

            sendReply(null, miner.getJob());
            break;
        case 'submit':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            miner.retarget();
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
            var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
            log('warn', componentName, 'Invalid method: ' + method + '(' + JSON.stringify(params) + ')' + minerText);
            break;
    }
}


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
            log('warn', 'Server', 'Error parsing json ' + data);
            return;
        }
        if (!jsonData.id){
            log('warn', 'Server', 'Miner RPC request missing RPC id');
            return;
        }
        else if (!jsonData.method){
            log('warn', 'Server', 'Miner RPC request missing RPC method');
            return;
        }
        handleMinerMethod(jsonData.id, jsonData.method, jsonData.params, req, res);
    });
});


function startPoolServer(callback) {
    getworkServer.listen(config.poolPort, function (error, result) {
        if (error) {
            log('error', 'Server', 'Could not start server listening on port ' + config.poolPort + ', error: ' + JSON.stringify(error));
            callback(false);
            return;
        }
        log('debug', 'Server', 'Started server listening on port ' + config.poolPort);
        callback(true);
    });
}