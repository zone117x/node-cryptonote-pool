var fs = require('fs');
var http = require('http');
var url = require("url");
var zlib = require('zlib');

var async = require('async');
var redis = require('redis');

var logger = require('./logUtil.js')({
    logLevel: config.logLevel,
    logColors: config.logColors
});


function log(severity, message){
    logger[severity]('API', null, null, message);
}


var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);

var redisClient = redis.createClient(config.redis.port, config.redis.host);

var redisCommands = [
    ['zremrangebyscore', config.coin + ':hashrate', '-inf', ''],
    ['zrangebyscore',  config.coin + ':hashrate', '', '+inf'],
    ['hgetall',  config.coin + ':stats'],
    ['smembers',  config.coin + ':blocksPending'],
    ['smembers',  config.coin + ':blocksUnlocked'],
    ['smembers',  config.coin + ':blocksOrphaned'],
    ['hgetall', config.coin + ':shares:roundCurrent'],
    ['hgetall', config.coin + ':stats']
];

var coinDecimals = config.coinUnits.toString().length - 1;

var currentStats = "";
var currentStatsCompressed = "";

var minerStats = {};

var liveConnections = {};
var addressConnections = {};



function collectStats(){

    var windowTime = (((Date.now() / 1000) - config.api.hashrateWindow) | 0).toString();
    redisCommands[0][3] = '(' + windowTime;
    redisCommands[1][2] = windowTime;


    async.parallel({
        pool: function(callback){
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', 'Error getting redis data ' + JSON.stringify(error));
                    callback(true);
                    return;
                }

                var data = {
                    stats: replies[2],
                    blocks: {
                        pending: replies[3],
                        unlocked: replies[4],
                        orphaned: replies[5]
                    }
                };

                var hashrates = replies[1];

                minerStats = {};

                for (var i = 0; i < hashrates.length; i++){
                    var hashParts = hashrates[i].split(':');
                    minerStats[hashParts[1]] = (minerStats[hashParts[1]] || 0) + parseInt(hashParts[0]);
                }

                var totalShares = 0;

                for (var miner in minerStats){
                    var shares = minerStats[miner];
                    totalShares += shares;
                    minerStats[miner] = getReadableHashRateString(shares / config.api.hashrateWindow);
                }

                data.miners = Object.keys(minerStats).length;

                data.hashrate = totalShares / config.api.hashrateWindow;

                data.roundHashes = 0;

                if (replies[6]){
                    for (var miner in replies[6]){
                        data.roundHashes += parseInt(replies[6][miner]);
                    }
                }

                if (replies[7]) {
                    data.lastBlockFound = replies[7].lastBlockFound;
                }

                callback(null, data);
            });
        },
        network: function(callback){
            apiInterfaces.rpcDaemon('getlastblockheader', {}, function(error, reply){
                if (error){
                    log('error', 'Error getting daemon data ' + JSON.stringify(error));
                    callback(true);
                    return;
                }
                var blockHeader = reply.block_header;
                callback(null, {
                    difficulty: blockHeader.difficulty,
                    height: blockHeader.height,
                    timestamp: blockHeader.timestamp,
                    reward: (blockHeader.reward / config.coinUnits).toFixed(2)
                });
            });
        },
        config: function(callback){
            callback(null, {
                ports: config.poolServer.ports,
                poolHost: config.poolHost,
                hashrateWindow: config.api.hashrateWindow,
                fee: config.blockUnlocker.poolFee,
                email: config.email,
                coin: config.coin,
                coinUnits: config.coinUnits,
                symbol: config.symbol,
                cryptonatorWidget: config.cryptonatorWidget,
                easyminerDownload: config.easyminerDownload,
                simplewalletDownload: config.simplewalletDownload,
                blockchainExplorer: config.blockchainExplorer,
                irc: config.irc,
                depth: config.blockUnlocker.depth,
                version: config.version
            });
        }
    }, function(error, results){
        if (error){
            log('error', 'Error collecting all stats');
        }
        else{
            currentStats = JSON.stringify(results);
            zlib.deflateRaw(currentStats, function(error, result){
                currentStatsCompressed = result;
                broadcastLiveStats();
            });

        }
        setTimeout(collectStats, config.api.updateInterval * 1000);
    });

}

function getReadableHashRateString(hashrate){
    var i = 0;
    var byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH' ];
    while (hashrate > 1024){
        hashrate = hashrate / 1024;
        i++;
    }
    return hashrate.toFixed(2) + byteUnits[i];
}

function broadcastLiveStats(){

    for (var uid in liveConnections){
        var res = liveConnections[uid];
        res.end(currentStatsCompressed);
    }


    var redisCommands = [];
    for (var address in addressConnections){
        redisCommands.push(['hgetall', config.coin + ':workers:' + address]);
    }
    redisClient.multi(redisCommands).exec(function(error, replies){

        var addresses = Object.keys(addressConnections);

        for (var i = 0; i < addresses.length; i++){
            var address = addresses[i];
            var stats = replies[i];
            var res = addressConnections[address];
            res.end(stats ? formatMinerStats(stats, address) : '{"error": "not found"');
        }
    });
}

function handleMinerStats(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');
    var address = urlParts.query.address;

    if (urlParts.query.longpoll === 'true'){
        redisClient.exists(config.coin + ':workers:' + address, function(error, result){
            if (!result){
                response.end(JSON.stringify({error: 'not found'}));
                return;
            }
            addressConnections[address] = response;
        });
    }
    else{
        redisClient.hgetall(config.coin + ':workers:' + address, function(error, stats){
            if (!stats){
                response.end(JSON.stringify({error: 'not found'}));
                return;
            }
            response.end(formatMinerStats(stats, address));
        });
    }
}


function formatMinerStats(redisData, address){

    redisData.hashrate = minerStats[address];

    var paid = ((redisData.paid || 0) / config.coinUnits).toFixed(coinDecimals);
    redisData.paid = paid + ' ' + config.symbol;

    var balance = ((redisData.balance || 0) / config.coinUnits).toFixed(coinDecimals);
    redisData.balance = balance + ' ' + config.symbol;

    return JSON.stringify({stats: redisData});
}


collectStats();

var server = http.createServer(function(request, response){

    if (request.method.toUpperCase() === "OPTIONS"){

        response.writeHead("204", "No Content", {
            "access-control-allow-origin": '*',
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, accept",
            "access-control-max-age": 10, // Seconds.
            "content-length": 0
        });

        return(response.end());
    }


    var urlParts = url.parse(request.url, true);

    switch(urlParts.pathname){
        case '/stats':
            var reply = currentStatsCompressed;
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Content-Length': reply.length
            });
            response.end(reply);
            break;
        case '/live_stats':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Connection': 'keep-alive'
            });
            var uid = Math.random().toString();
            liveConnections[uid] = response;
            response.on("close", function() {
                delete liveConnections[uid];
            });
            break;
        case '/stats_address':
            handleMinerStats(urlParts, response);
            break;
        default:
            response.writeHead(404, {
                'Access-Control-Allow-Origin': '*'
            });
            response.end('Invalid API call');
            break;
    }


});


server.listen(config.api.port, function(){
    log('debug', 'API listening on port ' + config.api.port);
});