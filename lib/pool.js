var fs = require('fs');
var http = require('http');
var net = require('net');
var crypto = require('crypto');

var async = require('async');
var bignum = require('bignum');
var multiHashing = require('multi-hashing');
var cnUtil = require('cryptonote-util');


var threadId = '(Thread ' + process.env.forkId + ') ';

var logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);
var utils = require('./utils.js');

var log = function(severity, system, text, data){
    global.log(severity, system, threadId + text, data);
};

var cryptoNight = multiHashing['cryptonight'];
var convertBlockBlob;
if(config.coin === "boolberry")
{
	convertBlockBlob = function(blob) {
		return cnUtil.convert_blob_bb(blob);
	};
}
else
{
	convertBlockBlob = function(blob) {
		return cnUtil.convert_blob(blob);
	};
} 
function cryptoNightFast(buf) {
    return cryptoNight(Buffer.concat([new Buffer([buf.length]), buf]), true);
}

function getFullScratchpad(callback) {
    apiInterfaces.rpcDaemon('getfullscratchpad', [], callback);
}

var scratchpad = new Buffer(0);
var scratchpadHeight = {block_id: '', height: 0};

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

setInterval(function(){
    var now = Date.now() / 1000 | 0;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        miner.retarget(now);
    }
}, config.poolServer.varDiff.retargetTime * 1000);


/* Every 30 seconds clear out timed-out miners and old bans */
setInterval(function(){
    var now = Date.now();
    var timeout = config.poolServer.minerTimeout * 1000;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if (now - miner.lastBeat > timeout){
            log('warn', logSystem, 'Miner timed out and disconnected %s@%s', [miner.login, miner.ip]);
            delete connectedMiners[minerId];
        }
    }

    if (banningEnabled){
        for (ip in bannedIPs){
            var banTime = bannedIPs[ip];
            if (now - banTime > config.poolServer.banning.time * 1000) {
                delete bannedIPs[ip];
                log('info', logSystem, 'Ban dropped for %s', [ip]);
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
        log('info', logSystem, 'Ban dropped for %s', [ip]);
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
        return convertBlockBlob(this.buffer).toString('hex');
    }
};



function getBlockTemplate(callback)
{
    var alias_info = {};
    if(aliases_config && aliases_config.aliases_que && aliases_config.aliases_que.length > 0)
    {
        alias_info = aliases_config.aliases_que[0];
        //log('debug', 'Aliases', 'Set alias for blocktemplate: ' + alias_info.alias + ' -> ' + alias_info.address);
    }
    var obj_to_rpc = {reserve_size: 8, wallet_address: config.poolServer.poolAddress, alias_details: alias_info};
    //log('debug', 'Aliases', 'GetBlockTemplate request str:  ' + JSON.stringify(obj_to_rpc));
    apiInterfaces.rpcDaemon('getblocktemplate', obj_to_rpc, callback);
}
function getAddms(hi, callback) {
    apiInterfaces.rpcDaemon('getjob', {id: '', hi: hi}, function(error, result) {
        callback(error, result.addms || []);
    });
}


function jobRefresh(loop, callback)
{
    //log('debug', 'jobRefresh', 'jobRefresh()');
    var callback_res = true;
    callback = callback || function(){};
    getBlockTemplate(function(error, result){
        if (loop)
            setTimeout(function(){
                jobRefresh(true);
            }, config.poolServer.blockRefreshInterval);
        if (error){
            log('error', logSystem, 'Error polling getblocktemplate %j', [error]);
            callback_res = false;

        }
        else if (!currentBlockTemplate || (result && (result.height > currentBlockTemplate.height))){
			log('info', logSystem, 'New block to mine at height %d w/ difficulty of %d', [result.height, result.difficulty]);
			processBlockTemplate(result);
		}
        setTimeout(jobRefresh, config.poolServer.blockRefreshInterval);
        callback(callback_res);
    });
}


function exportScratchpad()
{
    if(!config.poolServer.scratchpadFilePath || config.poolServer.scratchpadFilePath === "")
        return;

    log('debug', logSystem, 'exportScratchpad...');

    apiInterfaces.rpcDaemon('store_scratchpad', {local_file_path: config.poolServer.scratchpadFilePath }, function (error, result)
    {
        if (error)
        {
            log('error', logSystem, 'Error storing scratchpad: ' + JSON.stringify(error));
        }
        else
        {
            log('debug', logSystem, 'Scratchpad saved success');
        }
        setTimeout(exportScratchpad, config.poolServer.scratchpadFileUpdateInterval);
    });
}


function processBlockTemplate(template){

    if (currentBlockTemplate)
        validBlockTemplates.push(currentBlockTemplate);
	
	if (validBlockTemplates.length > 3)
        validBlockTemplates.shift();

    currentBlockTemplate = new BlockTemplate(template);

    getFullScratchpad(function (error, result) {
        if (error) {
            log('error', 'Job Refresher', 'Failed to get scratchpad: ' + error);
        } else {
            scratchpad = new Buffer(result.scratchpad_hex, 'hex');
            delete result.scratchpad_hex;
            scratchpadHeight = result.hi;
        }
	});
    for (var minerId in connectedMiners){
        //XMR FIXME:
        //var miner = connectedMiners[minerId];
        //miner.pushMessage('job', miner.getJob());
        (function(miner) {
            if (miner.longPoll) {
                miner.fetchAddms(function () {
                    if (miner.longPoll) {
                        log('debug', 'Long Polling', 'Sending new job to miner');
                        clearTimeout(miner.longPoll.timeout);

                        var job = miner.getJob();
                        log('debug', 'processBlockTemplate', 'reply5, job: ' + JSON.stringify(job));
                        miner.longPoll.reply(null,
                            {
                                blob: job.blob,
                                job_id: job.job_id,
                                target: job.target,
                                difficulty: job.difficulty,
                                prev_hi: job.prev_hi,
                                status: 'OK',
                                addms: miner.popAddms()
                            });
                        miner.longPoll = null;
                    }
                });
            }
            else if (miner.protocol === 'tcp') {
                miner.fetchAddms(function () {

                    var job = miner.getJob();
                    log('debug', 'processBlockTemplate', 'reply4, job: ' + JSON.stringify(job));
                    miner.pushMessage('job',
                        {
                            blob: job.blob,
                            job_id: job.job_id,
                            target: job.target,
                            difficulty: job.difficulty,
                            prev_hi: job.prev_hi,
                            status: 'OK',
                            addms: miner.popAddms()
                        });
                });
            }
        })(connectedMiners[minerId]);
    }
}



(function init(){
	exportScratchpad();
	reloadAliasesQue();
    jobRefresh(true, function(sucessful){
        if (!sucessful){
            log('error', logSystem, 'Could not start pool');
            return;
        }
		startPoolServerHttp(function(successful){
        });
        startPoolServerTcp(function(successful){

        });
    });
})();

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

var aliases_config = {};

function reloadAliasesQue()
{
    aliases_config = JSON.parse(fs.readFileSync('aliases_que.json'));
    if(aliases_config && aliases_config.aliases_que)
    {
        log('debug', 'Aliases', 'Loaded aliases que, ' + aliases_config.aliases_que.length + ' items');
    }

    setTimeout(reloadAliasesQue, 10000); //reload every 10 seconds
}

function storedAliasesQue()
{
    if(aliases_config && aliases_config.aliases_que)
    {
        fs.writeFileSync('aliases_que.json',  JSON.stringify(aliases_config.aliases_que));
        log('debug', 'Aliases', 'Stored aliases que, ' + aliases_config.aliases_que.length + ' items');
    }
}
 
function Miner(id, login, pass, ip, startingDiff, pushMessage){
    this.id = id;
    this.login = login;
    this.pass = pass;
    this.ip = ip;
    this.pushMessage = pushMessage;
    this.heartbeat();
    this.difficulty = startingDiff;
    this.validJobs = [];
    this.hi = {block_id: '', height: 0};
    this.addms = [];

    // Vardiff related variables
    this.shareTimeRing = utils.ringBuffer(16);
    this.lastShareTime = Date.now() / 1000 | 0;

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
    retarget: function(now){

        var options = config.poolServer.varDiff;

        var sinceLast = now - this.lastShareTime;
        var decreaser = sinceLast > VarDiff.tMax;

        var avg = this.shareTimeRing.avg(decreaser ? sinceLast : null);
        var newDiff;

        var direction;

        if (avg > VarDiff.tMax && this.difficulty > options.minDiff){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff > options.minDiff ? newDiff : options.minDiff;
            direction = -1;
        }
        else if (avg < VarDiff.tMin && this.difficulty < options.maxDiff){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff < options.maxDiff ? newDiff : options.maxDiff;
            direction = 1;
        }
        else{
            return;
        }

        if (Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > options.maxJump){
            var change = options.maxJump / 100 * this.difficulty * direction;
            newDiff = this.difficulty + change;
        }

        this.setNewDiff(newDiff);
        this.shareTimeRing.clear();
        if (decreaser) this.lastShareTime = now;
    },
    setNewDiff: function(newDiff){
        newDiff = Math.round(newDiff);
        if (this.difficulty === newDiff) return;
        log('info', logSystem, 'Retargetting difficulty %d to %d for %s', [this.difficulty, newDiff, this.login]);
        this.pendingDifficulty = newDiff;
		if (this.protocol === 'tcp')
            this.pushMessage('job', this.getJob());
    },
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
		log('debug', logSystem, 'empry_response, miner: ' + JSON.stringify(this));
        //XMR FIXME:
        //if (this.lastBlockHeight === currentBlockTemplate.height && !this.pendingDifficulty) {
		if (!this.hi.height || (this.lastBlockHeight === currentBlockTemplate.height && !this.pendingDifficulty))
        {
            return {
                blob: '',
                job_id: '',
                target: '',
                difficulty: '',
                prev_hi: this.hi
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
            target: target,
            difficulty: this.difficulty.toString(),
            prev_hi: this.hi
        };
    },
    checkBan: function(validShare){
        if (!banningEnabled) return;
        validShare ? this.validShares++ : this.invalidShares++;
        if (this.validShares + this.invalidShares >= config.poolServer.banning.checkThreshold){
            if (this.invalidShares / this.validShares >= config.poolServer.banning.invalidPercent / 100){
                log('warn', logSystem, 'Banned %s@%s', [this.login, this.ip]);
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
	    popAddms: function() {
        var temp = this.addms;
        this.addms = [];
        if(temp.length !== 0)
        {
            this.hi = temp[temp.length - 1].hi;
        }
        return temp;
    },
    fetchAddms: function(callback) {
        if(this.hi.height === 0
            || (this.hi.height + 1) === currentBlockTemplate.height
            || (this.addms.length && (this.addms[this.addms.length - 1].hi.height + 1) === currentBlockTemplate.height)) {
            return callback();
        }
        var miner = this;
        getAddms(this.hi, function(error, addms) {
            if(error) {
                log('error', logSystem, 'Error fetching addms');
                return callback();
            }
            miner.addms = [];
            for (var i = 0; i < addms.length; ++i) {
                var addm = addms[i];
                if(addm.hi.height > miner.hi.height) {
                    miner.addms.push(addm);
                }
            }
            callback();
        });
    }
};



function recordShareData(miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate){

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
        //redisCommands.push(['rename', config.coin + ':shares:roundCurrent', config.coin + ':shares:round' + job.height]);
        redisCommands.push(['hgetall', config.coin + ':shares:round' + job.height]);
    }

    redisClient.multi(redisCommands).exec(function(err, replies){
        if (err){
            log('error', logSystem, 'Failed to insert share data into redis %j \n %j', [err, redisCommands]);
            return;
        }
        if (blockCandidate){
            var workerShares = replies[replies.length - 1];
            var totalShares = Object.keys(workerShares).reduce(function(p, c){
                return p + parseInt(workerShares[c]);
            }, 0);
            redisClient.zadd(config.coin + ':blocks:candidates', job.height, [
                hashHex,
                Date.now() / 1000 | 0,
                blockTemplate.difficulty,
                totalShares
            ].join(':'), function(err, result){
                if (err){
                    log('error', logSystem, 'Failed inserting block candidate %s \n %j', [hashHex, err]);
                }
            });
        }

    });

    log('info', logSystem, 'Accepted %s share at difficulty %d/%d from %s@%s', [shareType, job.difficulty, shareDiff, miner.login, miner.ip]);

}

function processShare(miner, job, blockTemplate, nonce, resultHash){
    var shareBuffer = new Buffer(blockTemplate.buffer.length);
    blockTemplate.buffer.copy(shareBuffer);
    shareBuffer.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
    if (typeof(nonce) === 'number' && nonce % 1 === 0) {
        var nonceBuf = bignum(nonce, 10).toBuffer();
        var bufReversed = new Buffer(nonceBuf.toJSON().reverse());
        bufReversed.copy(shareBuffer, 1);
    } else {
        new Buffer(nonce, 'hex').copy(shareBuffer, 1);
    }
    //XMR FIXME:
    //new Buffer(nonce, 'hex').copy(shareBuffer, 39);

    var convertedBlob;
    var hash;
    var shareType;

    if (shareTrustEnabled && miner.trust.threshold <= 0 && miner.trust.penalty <= 0 && Math.random() > miner.trust.probability){
        hash = new Buffer(resultHash, 'hex');
        shareType = 'trusted';
        //Fixme do i need this?
		log('debug', logSystem, 'Share Validator', 'Trusted share from miner ' + miner.login + '@' + miner.ip);
    } else {
		convertedBlob = convertBlockBlob(shareBuffer);
		//XMR FIXME:
		//hash = cryptoNight(convertedBlob);
		hash = multiHashing.boolberry(convertedBlob, scratchpad, job.height);
        shareType = 'valid';
    }
    //BBR FIXME:
    //if (hash.toString('hex') !== resultHash) {
	//Fixme do i need this?
    //    log('warn', logSystem, 'Bad hash from miner ' +  miner.login + '@' + miner.ip +
    //        '\n scratchpadHeight.height=' + scratchpadHeight.height + ', job.height=' + job.height +
    //        '\n calculated hash: ' + hash.toString('hex') + ', transfered hash: ' + resultHash);


    //	log('warn', logSystem, 'Bad hash from miner ' +  miner.login + '@' + miner.ip +
    //        '\n scratchpadHeight.height=' + scratchpadHeight.height + ', miner.hi.height=' + miner.hi.height +
    //        '\n calculated hash: ' + hash.toString('hex') + ', transfered hash: ' + resultHash, false);
    if (hash.toString('hex') !== resultHash) {
        log('warn', logSystem, 'Bad hash from miner %s@%s', [miner.login, miner.ip]);
        return false;
    }

    var hashArray = hash.toJSON();
    hashArray.reverse();
    var hashNum = bignum.fromBuffer(new Buffer(hashArray));
    var hashDiff = diff1.div(hashNum);



    if (hashDiff.ge(blockTemplate.difficulty)){

        apiInterfaces.rpcDaemon('submitblock', [shareBuffer.toString('hex')], function(error, result){
            if (error){
                log('error', logSystem, 'Error submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, error]);
                // BBR FIXME:
                //log('error', logSystem, 'Error submitting block at height %d - %j', [job.height, error]);
                recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
            }
            else{
                var blockFastHash = cryptoNightFast(convertedBlob || convertBlockBlob(shareBuffer)).toString('hex');                
                log('info', logSystem,
                    'Block %s found at height %d by miner %s@%s - submit result: %j',
                    [blockFastHash.substr(0, 6), job.height, miner.login, miner.ip, result]
                );
                aliases_que.shift();
                storedAliasesQue();
                recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, shareType, blockTemplate);
                //XMR FIXME:
                //jobRefresh();
            }
        });
    }

    else if (hashDiff.lt(job.difficulty)){
        log('warn', logSystem, 'Rejected low difficulty share of %s from %s@%s', [hashDiff.toString(), miner.login, miner.ip]);
        return false;
    }
    else{
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
    }

    return true;
}


function handleMinerMethod(method, params, ip, portData, sendReply, pushMessage){


    var miner = connectedMiners[params.id];

    if(miner
        && params.hi
        && params.hi.height >= miner.hi.height
        //&& params.hi.height <= currentBlockTemplate.height
        && params.hi.block_id
        && /^[a-f0-9]{64}$/.test(params.hi.block_id))
    {
        miner.hi.height = params.hi.height;
        miner.hi.block_id = params.hi.block_id;
        if(params.hi.height > currentBlockTemplate.height)
        {
            log('error', logSystem, 'method ' + method + ', miner have height=' + miner.hi.height + ' bigger than currentBlockTemplate.height=' + currentBlockTemplate.height + ', refreshing job');
            //jobRefresh();

        }
    }


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
            miner = new Miner(minerId, params.login, params.pass, ip, portData.difficulty, pushMessage);
            if(params.hi
                && params.hi.height //&& params.hi.height <= currentBlockTemplate.height
                && params.hi.block_id
				&& /^[a-f0-9]{64}$/.test(params.hi.block_id)) {
                miner.hi.height = params.hi.height;
                miner.hi.block_id = params.hi.block_id;
				if(params.hi.height > currentBlockTemplate.height)
				{
					log('error', logSystem, 'method ' + method + ', miner have height=' + miner.hi.height + ' bigger than currentBlockTemplate.height=' + currentBlockTemplate.height + ', refreshing job');
				}
            }
            connectedMiners[minerId] = miner;
            miner.fetchAddms(function () {
				log('debug', logSystem, 'Setting up job...');
				var job = miner.getJob();
            sendReply(null, {
                id: minerId,
                //XMR FIXME: this was not inside the fetchaddms function upstream
                //job: miner.getJob(),
                job: {     
                        blob: job.blob,
                        job_id: job.job_id,
                        target: job.target,
                        difficulty: job.difficulty,
                        prev_hi: job.prev_hi,
                        status: 'OK',
                        addms: miner.popAddms()
                },
                status: 'OK'
            });
            log('info', logSystem, 'Miner connected %s@%s',  [params.login, miner.ip]);
			});
            break;
        case 'getjob':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            //XMR FIXME:
            //sendReply(null, miner.getJob());
            if (!longPollingEnabled || miner.protocol === 'tcp'){
                miner.fetchAddms(function ()
                {
                    var job = miner.getJob();
                    log('debug', logSystem, 'reply1, job: ' + JSON.stringify(job));
                    sendReply(null,
                        {
                            blob: job.blob,
                            job_id: job.job_id,
                            target: job.target,
                            difficulty: job.difficulty,
                            prev_hi: job.prev_hi,
                            status: 'OK',
                            addms: miner.popAddms()
                        });
                });
                return;
            }
            miner.longPoll = {
                timeout: setTimeout(function(){
                    delete miner.longPoll;
                    miner.fetchAddms(function ()
                    {
                        var job = miner.getJob();
                        log('debug', logSystem, 'reply2, job' );
                        sendReply(null, {
                            blob: job.blob,
                            job_id: job.job_id,
                            target: job.target,
                            difficulty: job.difficulty,
                            prev_hi: job.prev_hi,
                            status: 'OK',
                            addms: miner.popAddms()
                        });
                    });
                }, config.poolServer.longPolling.timeout),
                reply: sendReply
            };
            return;


            log('debug', logSystem, 'reply3, job' );
            var job = miner.getJob();
            sendReply(null, {
                blob: job.blob,
                job_id: job.job_id,
                target: job.target,
                difficulty: job.difficulty,
                prev_hi: job.prev_hi,
                status: 'OK',
                addms: miner.popAddms()
            });
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
	    if(job.height !== currentBlockTemplate.height) {
                sendReply('Job expired');
                return;
            }
            //XMR FIXME:
//            var blockTemplate = currentBlockTemplate.height === job.height ? currentBlockTemplate : validBlockTemplates.filter(function(t){
//                return t.height === job.height;
//            })[0];
              var blockTemplate = currentBlockTemplate;


            var shareAccepted = processShare(miner, job, blockTemplate, params.nonce, params.result);
            miner.checkBan(shareAccepted);
            if (shareTrustEnabled){
                if (shareAccepted){
                    miner.trust.probability -= shareTrustStepFloat;
                    if (miner.trust.probability < shareTrustMinFloat)
                        miner.trust.probability = shareTrustMinFloat;
                    miner.trust.penalty--;
                    miner.trust.threshold--;
                }
                else{
                    log('warn', logSystem, 'Share trust broken by %s@%s', [miner.login, miner.ip]);
                    miner.trust.probability = 1;
                    miner.trust.penalty = config.poolServer.shareTrust.penalty;
                }
            }

            if (!shareAccepted){
                sendReply('Low difficulty share');
                return;
            }

            var now = Date.now() / 1000 | 0;
            miner.shareTimeRing.append(now - miner.lastShareTime);
            miner.lastShareTime = now;
            //miner.retarget(now);

            sendReply(null, {status: 'OK'});
            break;
        case 'getfullscratchpad':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.hi = scratchpadHeight;
            sendReply(null, {status: 'OK', hi: scratchpadHeight, scratchpad_hex: scratchpad.toString('hex')});
            break;
        default:
            sendReply("invalid method");
            var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
            log('warn', logSystem, 'Invalid method: %s (%j) from %s', [method, params, minerText]);
            break;
    }
}


var httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nmining server online';


function startPoolServerTcp(callback){
    async.each(config.poolServer.ports, function(portData, cback){
		if (portData.protocol !== 'tcp'){
            cback();
            return;
        }

        var handleMessage = function(socket, jsonData, pushMessage){
            if (!jsonData.id) {
                log('warn', logSystem, 'Miner RPC request missing RPC id');
                return;
            }
            else if (!jsonData.method) {
                log('warn', logSystem, 'Miner RPC request missing RPC method');
                return;
            }

            var sendReply = function(error, result){
                if(!socket.writable) return;
                var sendData = JSON.stringify({
                    id: jsonData.id,
                    jsonrpc: "2.0",
                    error: error ? {code: -1, message: error} : null,
                    result: result
                }) + "\n";
                socket.write(sendData);
            };

            handleMinerMethod(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage);
        };

        net.createServer(function(socket){
            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            var dataBuffer = '';

            var pushMessage = function(method, params){
                if(!socket.writable) return;
                var sendData = JSON.stringify({
                    jsonrpc: "2.0",
                    method: method,
                    params: params
                }) + "\n";
                socket.write(sendData);
            };

            socket.on('data', function(d){
                dataBuffer += d;
                if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                    dataBuffer = null;
                    log('warn', logSystem, 'Socket flooding detected and prevented from %s', [socket.remoteAddress]);
                    socket.destroy();
                    return;
                }
                if (dataBuffer.indexOf('\n') !== -1){
                    var messages = dataBuffer.split('\n');
                    var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                    for (var i = 0; i < messages.length; i++){
                        var message = messages[i];
                        if (message.trim() === '') continue;
                        var jsonData;
                        try{
                            jsonData = JSON.parse(message);
                        }
                        catch(e){
                            if (message.indexOf('GET /') === 0) {
                                if (message.indexOf('HTTP/1.1') !== -1) {
                                    socket.end('HTTP/1.1' + httpResponse);
                                    break;
                                }
                                else if (message.indexOf('HTTP/1.0') !== -1) {
                                    socket.end('HTTP/1.0' + httpResponse);
                                    break;
                                }
                            }

                            log('warn', logSystem, 'Malformed message from %s: %s', [socket.remoteAddress, message]);
                            socket.destroy();

                            break;
                        }
                        handleMessage(socket, jsonData, pushMessage);
                    }
                    dataBuffer = incomplete;
                }
            }).on('error', function(err){
                if (err.code !== 'ECONNRESET')
                    log('warn', logSystem, 'Socket error from %s %j', [socket.remoteAddress, err]);
            }).on('close', function(){
                pushMessage = function(){};
            });

        }).listen(portData.port, function (error, result) {
            if (error) {
                log('error', logSystem, 'Could not start server listening on port %d, error: $j', [portData.port, error]);
                cback(true);
                return;
            }
            log('info', logSystem, 'Started server listening on port %d', [portData.port]);
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

