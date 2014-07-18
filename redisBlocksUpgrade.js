

/*

This script converts the block data in redis from the old format (v0.99.0.6 and earlier) to the new format
used in v0.99.1+

*/

var util = require('util');

var async = require('async');

var redis = require('redis');

require('./lib/configReader.js');

var apiInterfaces = require('./lib/apiInterfaces.js')(config.daemon, config.wallet);


function log(severity, system, text, data){

    var formattedMessage = text;

    if (data) {
        data.unshift(text);
        formattedMessage = util.format.apply(null, data);
    }

    console.log(severity + ': ' + formattedMessage);
}


var logSystem = 'reward script';

var redisClient = redis.createClient(config.redis.port, config.redis.host);

function getTotalShares(height, callback){

    redisClient.hgetall(config.coin + ':shares:round' + height, function(err, workerShares){

        if (err) {
            callback(err);
            return;
        }

        var totalShares = Object.keys(workerShares).reduce(function(p, c){
            return p + parseInt(workerShares[c])
        }, 0);

        callback(null, totalShares);

    });
}


async.series([
    function(callback){
        redisClient.smembers(config.coin + ':blocksUnlocked', function(error, result){
            if (error){
                log('error', logSystem, 'Error trying to get unlocke blocks from redis %j', [error]);
                callback();
                return;
            }
            if (result.length === 0){
                log('info', logSystem, 'No unlocked blocks in redis');
                callback();
                return;
            }

            var blocks = result.map(function(item){
                var parts = item.split(':');
                return {
                    height: parseInt(parts[0]),
                    difficulty: parts[1],
                    hash: parts[2],
                    time: parts[3],
                    shares: parts[4],
                    orphaned: 0
                };
            });

            async.map(blocks, function(block, mapCback){
                apiInterfaces.rpcDaemon('getblockheaderbyheight', {height: block.height}, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with getblockheaderbyheight RPC request for block %s - %j', [block.serialized, error]);
                        mapCback(null, block);
                        return;
                    }
                    if (!result.block_header){
                        log('error', logSystem, 'Error with getblockheaderbyheight, no details returned for %s - %j', [block.serialized, result]);
                        mapCback(null, block);
                        return;
                    }
                    var blockHeader = result.block_header;
                    block.reward = blockHeader.reward;
                    mapCback(null, block);
                });
            }, function(err, blocks){

                if (blocks.length === 0){
                    log('info', logSystem, 'No unlocked blocks');
                    callback();
                    return;
                }

                var zaddCommands = [config.coin + ':blocks:matured'];

                for (var i = 0; i < blocks.length; i++){
                    var block = blocks[i];
                    zaddCommands.push(block.height);
                    zaddCommands.push([
                        block.hash,
                        block.time,
                        block.difficulty,
                        block.shares,
                        block.orphaned,
                        block.reward
                    ].join(':'));
                }

                redisClient.zadd(zaddCommands, function(err, result){
                    if (err){
                        console.log('failed zadd ' + JSON.stringify(err));
                        callback();
                        return;
                    }
                    console.log('successfully converted unlocked blocks to matured blocks');
                    callback();
                });


            });
        });
    },
    function(callback){
        redisClient.smembers(config.coin + ':blocksPending', function(error, result) {
            if (error) {
                log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
                callback();
                return;
            }
            if (result.length === 0) {
                log('info', logSystem, 'No pending blocks in redis');
                callback();
                return;
            }

            async.map(result, function(item, mapCback){
                var parts = item.split(':');
                var block = {
                    height: parseInt(parts[0]),
                    difficulty: parts[1],
                    hash: parts[2],
                    time: parts[3],
                    serialized: item
                };
                getTotalShares(block.height, function(err, shares){
                    block.shares = shares;
                    mapCback(null, block);
                });
            }, function(err, blocks){

                var zaddCommands = [config.coin + ':blocks:candidates'];

                for (var i = 0; i < blocks.length; i++){
                    var block = blocks[i];
                    zaddCommands.push(block.height);
                    zaddCommands.push([
                        block.hash,
                        block.time,
                        block.difficulty,
                        block.shares
                    ].join(':'));
                }

                redisClient.zadd(zaddCommands, function(err, result){
                    if (err){
                        console.log('failed zadd ' + JSON.stringify(err));
                        return;
                    }
                    console.log('successfully converted pending blocks to block candidates');
                });

            });

        });
    }
], function(){
    process.exit();
});