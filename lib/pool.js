var fs = require('fs');
var http = require('http');
var net = require('net');
var crypto = require('crypto');

var async = require('async');
var bignum = require('bignum');
var redis = require('redis');
var multiHashing = require('multi-hashing');
var cnUtil = require('cryptonote-util');

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

function cryptoNightFast(buf) {
    return cryptoNight(Buffer.concat([new Buffer([buf.length]), buf]), true);
}

var diff1 = bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);

var instanceId = crypto.randomBytes(4);

var validBlockTemplates = [];
var currentBlockTemplate;

var connectedMiners = {};

var bannedIPs = {};

var shareTrustEnabled = config.poolServer.shareTrust && config.poolServer.shareTrust.enabled;
var shareTrustStepFloat = shareTrustEnabled ? config.poolServer.shareTrust.stepDown / 100 : 0;
var shareTrustMinFloat = shareTrustEnabled ? config.poolServer.shareTrust.min / 100 : 0;


var banningEnabled = config.poolServer.banning && config.poolServer.banning.enabled;

var longPollingEnabled = config.poolServer.longPolling && config.poolServer.longPolling.enabled;

/* Every 10 seconds clear out timed-out miners and old bans */
setInterval(function(){
    var now = Date.now();
    var timeout = config.poolServer.minerTimeout * 1000;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if (now - miner.lastBeat > timeout){
            log('debug', 'Miner Cleaner', 'Disconnected miner ' + miner.login);
            delete connectedMiners[minerId];
        }
    }

    if (banningEnabled){
        for (ip in bannedIPs){
            var banTime = bannedIPs[ip];
            if (now - banTime > config.poolServer.banning.time * 1000) {
                delete bannedIPs[ip];
                log('debug', 'Ban Hammer', 'Ban dropped for ' + ip);
            }
        }
    }

}, 30000);


process.on('message', function(message) {
    switch (message.type) {
        case 'banIP':
            bannedIPs[message.ip] = Date.now();
            break;
    }
});


function IsBannedIp(ip){
    if (!banningEnabled || !bannedIPs[ip]) return false;

    var bannedTime = bannedIPs[ip];
    var bannedTimeAgo = Date.now() - bannedTime;
    var timeLeft = config.poolServer.banning.time * 1000 - bannedTimeAgo;
    if (timeLeft > 0){
        return true;
    }
    else {
        delete bannedIPs[ip];
        log('debug', 'Ban Hammer', 'Ban dropped for ' + ip);
        return false;
    }
}


function BlockTemplate(template){
    this.blob = template.blocktemplate_blob;
    this.difficulty = template.difficulty;
    this.height = template.height;
    this.reserveOffset = template.reserved_offset;
    this.buffer = new Buffer(this.blob, 'hex');
    instanceId.copy(this.buffer, this.reserveOffset + 4, 0, 3);
    this.extraNonce = 0;
}
BlockTemplate.prototype = {
    nextBlob: function(){
        this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
        return cnUtil.convert_blob(this.buffer).toString('hex');
    }
};



function getBlockTemplate(callback){
    apiInterfaces.rpcDaemon('getblocktemplate', {reserve_size: 8, wallet_address: config.poolServer.poolAddress}, callback);
}



function jobRefresh(callback){
    callback = callback || function(){};
    getBlockTemplate(function(error, result){
        if (error){
            log('error', 'Job Refresher', 'Error polling getblocktemplate ' + JSON.stringify(error));
            callback(false);
            return;
        }
        if (!currentBlockTemplate || result.height > currentBlockTemplate.height){
            log('debug', 'Job Refresher', 'New block available to mine at height ' + result.height + ' w/ difficulty of ' + result.difficulty);
            processBlockTemplate(result);
        }
        setTimeout(jobRefresh, config.poolServer.blockRefreshInterval);
        callback(true);
    })
}



function processBlockTemplate(template){

    if (currentBlockTemplate)
        validBlockTemplates.push(currentBlockTemplate);

    if (validBlockTemplates.length > 10)
        validBlockTemplates.shift();

    currentBlockTemplate = new BlockTemplate(template);

    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if (miner.longPoll){
            log('debug', 'Long Polling', 'Sending new job to miner');
            clearTimeout(miner.longPoll.timeout);
            miner.longPoll.reply(null, miner.getJob());
            miner.longPoll = null;
        }
        else if (miner.protocol === 'tcp'){
            miner.pushMessage('job', miner.getJob());
        }
    }
}


var VarDiff = (function(){
    var variance = config.poolServer.varDiff.variancePercent / 100 * config.poolServer.varDiff.targetTime;
    return {
        variance: variance,
        bufferSize: config.poolServer.varDiff.retargetTime / config.poolServer.varDiff.targetTime * 4,
        tMin: config.poolServer.varDiff.targetTime - variance,
        tMax: config.poolServer.varDiff.targetTime + variance,
        maxJump: config.poolServer.varDiff.maxJump
    };
})();


(function init(){
    jobRefresh(function(sucessful){
        if (!sucessful){
            log('error', 'Could not start pool');
            return;
        }
        startPoolServerHttp(function(successful){

        });
        startPoolServerTcp(function(successful){

        });
    });
})();


function Miner(id, login, pass, ip, startingDiff, protocol, pushMessage){
    this.id = id;
    this.login = login;
    this.pass = pass;
    this.ip = ip;
    this.protocol = protocol;
    this.pushMessage = pushMessage;
    this.heartbeat();
    this.difficulty = startingDiff;
    this.validJobs = [];

    this.validShares = 0;
    this.invalidShares = 0;

    if (shareTrustEnabled) {
        this.trust = {
            threshold: config.poolServer.shareTrust.threshold,
            probability: 1,
            penalty: 0
        };
    }
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

        var padded = new Buffer(32);
        padded.fill(0);

        var diffBuff = diff1.div(this.difficulty).toBuffer();
        diffBuff.copy(padded, 32 - diffBuff.length);

        var buff = padded.slice(0, 4);
        var buffArray = buff.toJSON();
        buffArray.reverse();
        var buffReversed = new Buffer(buffArray);
        this.target = buffReversed.readUInt32BE(0);
        var hex = buffReversed.toString('hex');
        return hex;
    },
    getJob: function(){
        if (this.lastBlockHeight === currentBlockTemplate.height && !this.pendingDifficulty) {
            return {
                blob: '',
                job_id: '',
                target: ''
            };
        }

        var blob = currentBlockTemplate.nextBlob();
        this.lastBlockHeight = currentBlockTemplate.height;
        var target = this.getTargetHex();

        var newJob = {
            id: utils.uid(),
            extraNonce: currentBlockTemplate.extraNonce,
            height: currentBlockTemplate.height,
            difficulty: this.difficulty,
            diffHex: this.diffHex,
            submissions: []
        };

        this.validJobs.push(newJob);

        if (this.validJobs.length > 4)
            this.validJobs.shift();

        return {
            blob: blob,
            job_id: newJob.id,
            target: target
        };
    },
    checkBan: function(validShare){
        if (!banningEnabled) return;
        validShare ? this.validShares++ : this.invalidShares++;
        if (this.validShares + this.invalidShares >= config.poolServer.banning.checkThreshold){
            if (this.invalidShares / this.validShares >= config.poolServer.banning.invalidPercent / 100){
                log('warn', 'Ban Hammer', 'Banned ' + this.login + '@' + this.ip);
                bannedIPs[this.ip] = Date.now();
                delete connectedMiners[this.id];
                process.send({type: 'banIP', ip: this.ip});
            }
            else{
                this.invalidShares = 0;
                this.validShares = 0;
            }
        }
    },
    retarget: function(){

        var options = config.poolServer.varDiff;

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

        var diffJump = newDiff - this.difficulty;
        if (Math.abs(diffJump) > VarDiff.maxJump){
            if (diffJump < 0)
                newDiff = this.difficulty - VarDiff.maxJump;
            else
                newDiff = this.difficulty + VarDiff.maxJump;
        }

        this.timeBuffer.clear();
        log('debug', 'Difficulty Retargeter', 'Retargetting difficulty ' + this.difficulty + ' to ' + newDiff +' for ' + this.login);
        this.pendingDifficulty = newDiff;
    }
};



function recordShareData(miner, job, shareDiff, blockCandidate, hashHex){

    var dateNow = Date.now();
    var dateNowSeconds = dateNow / 1000 | 0;

    var redisCommands = [
        ['hincrby', config.coin + ':shares:roundCurrent', miner.login, job.difficulty],
        ['zadd', config.coin + ':hashrate', dateNowSeconds, [job.difficulty, miner.login, dateNow].join(':')],
        ['hincrby', config.coin + ':workers:' + miner.login, 'hashes', job.difficulty],
        ['hset', config.coin + ':workers:' + miner.login, 'lastShare', dateNowSeconds]
    ];

    if (blockCandidate){
        redisCommands.push(['sadd', config.coin + ':blocksPending', [job.height, currentBlockTemplate.difficulty, hashHex, Date.now() / 1000 | 0].join(':')]);
        redisCommands.push(['rename', config.coin + ':shares:roundCurrent', config.coin + ':shares:round' + job.height]);
        redisCommands.push(['hset', config.coin + ':stats', 'lastBlockFound', Date.now()]);
    }

    redisClient.multi(redisCommands).exec(function(err, replies){
        if (err){
            log('error', 'Redis Writer', 'Failed to insert share data into redis ' + JSON.string(err));
        }
    });

    log('debug', 'Share Validator', 'Accepted share at difficulty ' + job.difficulty + '/' + shareDiff + ' from ' + miner.login + '@' + miner.ip);

}

function processShare(miner, job, blockTemplate, nonce, resultHash){
    var shareBuffer = new Buffer(blockTemplate.buffer.length);
    blockTemplate.buffer.copy(shareBuffer);
    shareBuffer.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
    new Buffer(nonce, 'hex').copy(shareBuffer, 39);

    var convertedBlob;
    var hash;

    if (shareTrustEnabled && miner.trust.threshold <= 0 && miner.trust.penalty <= 0 && Math.random() > miner.trust.probability){
        hash = new Buffer(resultHash, 'hex');
        log('debug', 'Share Validator', 'Trusted share from miner '  + miner.login + '@' + miner.ip);
    }
    else {
        convertedBlob = cnUtil.convert_blob(shareBuffer);
        hash = cryptoNight(convertedBlob);
    }


    if (hash.toString('hex') !== resultHash) {
        log('error', 'Share Validator', 'Bad hash from miner ' + miner.login + '@' + miner.ip);
        return false;
    }

    var hashArray = hash.toJSON();
    hashArray.reverse();
    var hashNum = bignum.fromBuffer(new Buffer(hashArray));
    var hashDiff = diff1.div(hashNum);

    var blockFastHash;

    if (hashDiff.ge(blockTemplate.difficulty)){
        blockFastHash = cryptoNightFast(convertedBlob || cnUtil.convert_blob(shareBuffer)).toString('hex');

        apiInterfaces.rpcDaemon('submitblock', [shareBuffer.toString('hex')], function(error, result){
            if (error){
                log('error', 'Share Validator', 'Error submitting block at height ' + job.height + ' ' + JSON.stringify(error));
                recordShareData(miner, job, hashDiff.toString(), false);
            }
            else{
                log('special', 'Share Validator', 'Block ' + blockFastHash.substr(0, 6) + ' found at height ' + job.height +
                    ' by miner ' + miner.login + '@' + miner.ip);
                log('debug', 'Block submit result ' + JSON.stringify(result));
                recordShareData(miner, job, hashDiff.toString(), true, blockFastHash);
                jobRefresh();
            }
        });
    }

    else if (hashDiff.lt(job.difficulty)){
        log('error', 'Share Validator', 'Rejected low difficulty share of ' + hashDiff.toString());
        return false;
    }
    else{
        recordShareData(miner, job, hashDiff.toString());
    }

    /*var hashTarget = hash.readUInt32LE(hash.length - 4);
    var percent = (miner.target / hashTarget * 100).toFixed(2);

    if (hashTarget > miner.target){
        log('error', 'Share Validator', 'Rejected high share target - ' + percent + '% of target (' + miner.target + '/' + hashTarget + ')');
        return false;
    }
    log('debug', 'Share Validator', 'Accepted share at difficulty ' + hashDiff.toString() + ' - ' + percent + '% of target (' + miner.target + '/' + hashTarget + ')');
    */

    return true;
}


//function handleMinerMethod(id, method, params, req, res, startingDiff){
function handleMinerMethod(method, params, ip, portData, sendReply, pushMessage){

    var componentName = 'RPC Handler';

    var miner = connectedMiners[params.id];

    switch(method){
        case 'login':
            if (!params.login){
                sendReply('missing login');
                return;
            }
            if (!utils.isValidAddress(params.login, config.poolServer.poolAddress[0])){
                sendReply('invalid address used for login');
                return;
            }
            if (IsBannedIp(ip)){
                sendReply('your IP is banned');
                return;
            }
            var minerId = utils.uid();
            miner = new Miner(minerId, params.login, params.pass, ip, portData.difficulty, portData.protocol, pushMessage);
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
            if (!longPollingEnabled || miner.protocol === 'tcp'){
                sendReply(null, miner.getJob());
                return;
            }
            miner.longPoll = {
                timeout: setTimeout(function(){
                    delete miner.longPoll;
                    sendReply(null, miner.getJob());
                }, config.poolServer.longPolling.timeout),
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

            var job = miner.validJobs.filter(function(job){
                return job.id === params.job_id;
            })[0];

            if (!job){
                sendReply('Invalid job id');
                return;
            }

            if (job.submissions.indexOf(params.nonce) !== -1){
                sendReply('Duplicate share');
                return;
            }

            job.submissions.push(params.nonce);

            var blockTemplate = currentBlockTemplate.height === job.height ? currentBlockTemplate : validBlockTemplates.filter(function(t){
                return t.height === job.height;
            })[0];

            if (!blockTemplate){
                sendReply('Block expired');
                return;
            }

            var shareAccepted = processShare(miner, job, blockTemplate, params.nonce, params.result);
            miner.checkBan(shareAccepted);
            if (!shareAccepted){
                sendReply('Low difficulty share');
                return;
            }
            if (shareTrustEnabled){
                if (shareAccepted){
                    miner.trust.probability -= shareTrustStepFloat;
                    if (miner.trust.probability < shareTrustMinFloat)
                        miner.trust.probability = shareTrustMinFloat;
                    miner.trust.penalty--;
                    miner.trust.threshold--;
                }
                else{
                    miner.trust.probability = 1;
                    miner.trust.penalty = config.poolServer.shareTrust.penalty;
                }
            }
            miner.retarget();
            sendReply(null, {status: 'OK'});
            break;
        default:
            sendReply("invalid method");
            var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
            log('warn', componentName, 'Invalid method: ' + method + '(' + JSON.stringify(params) + ')' + minerText);
            break;
    }
}


function startPoolServerTcp(callback){
    async.each(config.poolServer.ports, function(portData, cback){
        if (portData.protocol !== 'tcp'){
            cback();
            return;
        }

        var handleMessage = function(socket, jsonData, pushMessage){
            if (!jsonData.id) {
                log('warn', 'TCP Server', 'Miner RPC request missing RPC id');
                return;
            }
            else if (!jsonData.method) {
                log('warn', 'TCP Server', 'Miner RPC request missing RPC method');
                return;
            }

            var sendReply = function(error, result){
                var sendData = JSON.stringify({
                    id: jsonData.id,
                    jsonrpc: "2.0",
                    error: error ? {code: -1, message: error} : null,
                    result: result
                });
                socket.write(sendData);
            };

            socket.on('close', function() {
                sendReply = function(){};
            });

            handleMinerMethod(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage);
        };

        net.createServer(function(socket){
            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            var dataBuffer = '';

            var pushMessage = function(method, params){
                var sendData = JSON.stringify({
                    jsonrpc: "2.0",
                    method: method,
                    params: params
                });
                socket.write(sendData);
            };

            socket.on('data', function(d){
                dataBuffer += d;
                if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                    dataBuffer = null;
                    log('warn', 'TCP Server', 'Socket flooding detected and prevented from ' + socket.remoteAddress);
                    socket.destroy();
                    return;
                }
                if (dataBuffer.indexOf('\n') !== -1){
                    var messages = dataBuffer.split('\n');
                    var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                    messages.forEach(function(message){
                        if (message.trim() === '') return;
                        var jsonData;
                        try {
                            jsonData = JSON.parse(message);
                        } catch(e) {
                            log('warn', 'TCP Server', 'Malformed message ' + message);
                            socket.destroy();
                            return;
                        }

                        handleMessage(socket, jsonData, pushMessage);

                    });
                    dataBuffer = incomplete;
                }
            }).on('error', function(err){
                if (err.code !== 'ECONNRESET')
                    log('warn', 'TCP Server', 'Socket error ' + JSON.stringify(err));
            }).on('close', function(){
                pushMessage = function(){};
            });

        }).listen(portData.port, function (error, result) {
            if (error) {
                log('error', 'TCP Server', 'Could not start server listening on port ' + portData.port + ', error: ' + JSON.stringify(error));
                cback(true);
                return;
            }
            log('debug', 'TCP Server', 'Started server listening on port ' + portData.port);
            cback();
        });

    }, function(err){
        if (err)
            callback(false);
        else
            callback(true);
    });
}



function startPoolServerHttp(callback) {

    async.each(config.poolServer.ports, function(portData, cback) {

        if (portData.protocol !== 'http'){
            cback();
            return;
        }

        var getworkServer = http.createServer(function (req, res) {
            var data = '';
            req.setEncoding('utf8');
            req.on('data', function (chunk) {
                data += chunk;
                if (Buffer.byteLength(data, 'utf8') > 10240) { //10KB
                    data = null;
                    log('warn', 'HTTP Server', 'Socket flooding detected and prevented from ' + req.connection.remoteAddress);
                    req.connection.destroy();
                }
            });
            req.on('end', function () {
                var jsonData;
                try {
                    jsonData = JSON.parse(data);
                }
                catch (e) {
                    log('warn', 'HTTP Server', 'Error parsing json ' + data);
                    return;
                }
                if (!jsonData.id) {
                    log('warn', 'HTTP Server', 'Miner RPC request missing RPC id');
                    return;
                }
                else if (!jsonData.method) {
                    log('warn', 'HTTP Server', 'Miner RPC request missing RPC method');
                    return;
                }

                var sendReply = function(error, result){
                    var sendData = JSON.stringify({
                        id: jsonData.id,
                        jsonrpc: "2.0",
                        error: error ? {code: -1, message: error} : null,
                        result: result
                    });
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Content-Length', sendData.length);
                    if (longPollingEnabled) {
                        res.setHeader('X-Long-Polling', '');
                    }
                    res.end(sendData);
                };

                res.on('close', function(){
                    sendReply = function(){
                        //log('debug', componentName, 'Tried sending data to an abruptly disconnected miner');
                    };
                });

                handleMinerMethod(jsonData.method, jsonData.params, req.connection.remoteAddress, portData, sendReply);
            });
        });


        getworkServer.listen(portData.port, function (error, result) {
            if (error) {
                log('error', 'HTTP Server', 'Could not start server listening on port ' + portData.port + ', error: ' + JSON.stringify(error));
                cback(true);
                return;
            }
            log('debug', 'HTTP Server', 'Started server listening on port ' + portData.port);
            cback();
        });

    }, function(err){
        if (err)
            callback(false);
        else
            callback(true);
    });

}