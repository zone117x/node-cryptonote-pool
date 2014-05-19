var fs = require('fs');

var async = require('async');

var redis = require('redis');


var config = JSON.parse(fs.readFileSync('config.json'));

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);

var logger = require('./logUtil.js')({
    logLevel: config.logLevel,
    logColors: config.logColors
});

function log(severity, message){
    logger[severity]('Payment Processor', null, null, message);
}

log('debug', 'Started');

var redisClient = redis.createClient(config.redis.port, config.redis.host);


//Use this in payment processing to get block info once batch RPC is supported
/*
var batchArray = [
    ['getblockheaderbyheight', {height: 21}],
    ['getblockheaderbyheight', {height: 22}],
    ['getblockheaderbyheight', {height: 23
    }]
];

apiInterfaces.batchRpcDaemon(batchArray, function(error, response){

});
*/


function runInterval(){
    async.waterfall([

        //Get all pending blocks in redis
        function(callback){
            redisClient.smembers(config.coin + ':blocksPending', function(error, result){
                if (error){
                    log('error', 'Error trying to get pending blocks from redis ' + JSON.stringify(error));
                    callback(true);
                    return;
                }
                if (result.length === 0){
                    log('debug', 'No pending blocks in redis');
                    callback(true);
                    return;
                }
                var blocks = result.map(function(item){
                    var parts = item.split(':');
                    return {
                        height: parseInt(parts[0]),
                        difficulty: parseInt(parts[1]),
                        hash: parts[2],
                        serialized: item
                    };
                });
                callback(null, blocks);
            });
        },

        //Get details for each pending block via daemon API
        function(blocks, callback){
            async.each(blocks, function(block, mapCback){
                apiInterfaces.rpcDaemon('getblockheaderbyhash', {hash: block.hash}, function(error, result){
                    if (error){
                        log('error', 'Error with getblockheaderbyhash RPC request for block ' + block.serialized
                         + ' - ' + JSON.stringify(error));
                        mapCback();
                        return;
                    }
                    if (!result.block_header){
                        log('error', 'Error with getblockheaderbyhash, no details returned for ' + block.serialized
                            + ' - ' + JSON.stringify(result));
                        mapCback();
                        return;
                    }
                    var blockHeader = result.block_header;
                    block.depth = blockHeader.depth;
                    block.unlocked = block.depth >= config.payments.depth;
                    //block.orphan = blockHeader.orphan_status;
                    block.reward = blockHeader.reward;
                    mapCback();
                });
            }, function(err, results){
                callback(null, blocks)
            })
        },

        //Get worker shares for each unlocked or orphaned block
        function(blocks, callback){
            var blocksToProcess = blocks.filter(function(block){
                return block.unlocked || block.orphan;
            });

            if (blocksToProcess.length === 0){
                log('debug', 'No pending blocks are unlocked or orphaned yet (' + blocks.length + ' pending)');
                callback(true);
                return;
            }

            var redisCommands = blocksToProcess.map(function(block){
                return ['hgetall', config.coin + ':shares:round' + block.height];
            });


            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', 'Error with getting round shares from redis ' + JSON.stringify(error));
                    callback(true);
                    return;
                }
                for (var i = 0; i < replies.length; i++){
                    blocksToProcess[i].workerShares = replies[i];
                }
                callback(null, blocksToProcess);
            });

        },

        /* Check if blocks are orphaned */
        function(blocks, callback){
            async.each(blocks, function(block, mapCback){
                apiInterfaces.rpcDaemon('getblockheaderbyheight', {height: block.height}, function(error, result){
                    if (error){
                        log('error', 'Error with getblockheaderbyheight RPC request for block ' + block.serialized
                            + ' - ' + JSON.stringify(error));
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    if (!result.block_header){
                        log('error', 'Error with getblockheaderbyheight, no details returned for ' + block.serialized
                            + ' - ' + JSON.stringify(result));
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    var blockHeader = result.block_header;
                    block.orphan = (blockHeader.hash !== block.hash);
                    mapCback();
                });
            }, function(err, results){
                callback(null, blocks)
            })
        },

        //Handle orphaned blocks
        function(blocks, callback){
            var orphanCommands = [];
            blocks.forEach(function(block){
                if (!block.orphan) return;
                var workerShares = block.workerShares;
                orphanCommands.push(['del', config.coin + ':shares:round' + block.height]);
                orphanCommands.push(['smove', config.coin + ':blocksPending', config.coin + ':blocksOrphaned', block.serialized]);
                Object.keys(workerShares).forEach(function(worker){
                    orphanCommands.push(['hincrby', config.coin + ':shares:roundCurrent',
                        worker, workerShares[worker]]);
                });
            });
            if (orphanCommands.length > 0){
                redisClient.multi(orphanCommands).exec(function(error, replies){
                    if (error){
                        log('error', 'Error with cleaning up data in redis for orphan block(s) ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }
                    callback(null, blocks);
                });
            }
            else{
                callback(null, blocks);
            }
        },

        //Handle unlocked blocks
        function(blocks, callback){
            var unlockedBlocksCommands = [];
            var payments = {};
            blocks.forEach(function(block){
                if (!block.unlocked) return;
                unlockedBlocksCommands.push(['del', config.coin + ':shares:round' + block.height]);
                unlockedBlocksCommands.push(['smove', config.coin + ':blocksPending', config.coin + ':blocksUnlocked', block.serialized]);
                var reward = block.reward - (block.reward * (config.payments.poolFee / 100));
                var workerShares = block.workerShares;
                var totalShares = Object.keys(workerShares).reduce(function(p, c){
                    return p + parseInt(workerShares[c])
                }, 0);
                Object.keys(workerShares).forEach(function(worker){
                    var percent = workerShares[worker] / totalShares;
                    var workerReward = reward * percent;
                    payments[worker] = (payments[worker] || 0) + workerReward;
                });
            });


            var transferData = {
                destinations: [],
                fee: config.transferFee,
                mixin: 0,
                unlock_time: 0
            };

            for (var worker in payments){
                transferData.destinations.push({amount: parseInt(payments[worker]), address: worker});
            }

            apiInterfaces.rpcWallet('transfer', transferData, function(error, result){
                if (error){
                    log('error', 'Error with transfer RPC request to wallet daemon '+ JSON.stringify(error));
                    //console.log(JSON.stringify(transferData));
                    callback(true);
                    return;
                }
                log('debug', 'Payments sent ' + JSON.stringify(payments));
                redisClient.multi(unlockedBlocksCommands).exec(function(error, replies){
                    if (error){
                        log('error', 'Error with cleaning up data in redis for paid/unlocked block(s) ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }
                    callback(null);
                });
            });

            callback(true);
        }

    ], function(error, result){
        setTimeout(runInterval, config.payments.interval * 1000);
    })
}

runInterval();