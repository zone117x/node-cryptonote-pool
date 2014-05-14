var fs = require('fs');
var http = require('http');
var url = require("url");

var async = require('async');
var redis = require('redis');

var config = JSON.parse(fs.readFileSync('config.json'));

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
    ['smembers',  config.coin + ':blocksOrphaned']
];

var currentStats = "";

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
                data.hashrate = getReadableHashRateString(totalShares / config.api.hashrateWindow);

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
                    height: blockHeader.height
                });
            });
        },
        config: function(callback){
            callback(null, {
                poolPort: config.poolPort,
                poolHost: config.poolHost,
                hashrateWindow: config.api.hashrateWindow,
                fee: config.payments.poolFee,
                email: config.email
            });
        }
    }, function(error, results){
        if (!error){
            currentStats = JSON.stringify(results);
            broadcastLiveStats();
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
    var statData = 'data: ' + currentStats + '\n\n';
    for (var uid in liveConnections){
        var res = liveConnections[uid];
        res.write(statData);
    }

    for (var address in addressConnections){
        var res = addressConnections[address];
        var stats = minerStats[address];
        if (!stats) res.end();
        else res.write('data: ' + JSON.stringify({stats: stats}) + '\n\n');
    }

}


collectStats();

var server = http.createServer(function(request, response){

    var origin = (request.headers.origin || "*");


    if (request.method.toUpperCase() === "OPTIONS"){

        response.writeHead("204", "No Content", {
            "access-control-allow-origin": origin,
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
            var reply = currentStats;
            response.writeHead("200", {
                'Access-Control-Allow-Origin': origin,
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);
            break;
        case '/live_stats':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': origin,
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            response.write('\n');
            var uid = Math.random().toString();
            liveConnections[uid] = response;
            response.on("close", function() {
                delete liveConnections[uid];
            });
            break;
        case '/stats_address':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': origin,
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            response.write('\n');
            var address = urlParts.query.address;
            var stats = minerStats[address];

            if (!stats){
                var error = JSON.stringify({error: 'not found'});
                var statData = 'data: ' + error + '\n\n';
                response.end(statData);
                return;
            }
            response.write('data: ' + JSON.stringify({stats:stats}) + '\n\n');
            addressConnections[address] = response;
            response.on("close", function() {
                delete addressConnections[address];
            });
            break;
        default:
            response.writeHead(404, {
                'Access-Control-Allow-Origin': origin
            });
            response.end('Invalid API call');
            break;
    }


});


server.listen(config.api.port, function(){
    log('debug', 'API listening on port ' + config.api.port);
});