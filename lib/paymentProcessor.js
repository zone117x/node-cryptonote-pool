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
    logger[severity]('Payments', null, null, message);
}

log('debug', 'Started');

var redisClient = redis.createClient(config.redis.port, config.redis.host);


function runInterval(){
    async.waterfall([

        //Get worker keys
        function(callback){
            redisClient.keys(config.coin + ':workers:*', function(error, result) {
                if (error) {
                    log('error', 'Error trying to get worker balances from redis ' + JSON.stringify(error));
                    callback(true);
                    return;
                }
                callback(null, result);
            });
        },

        //Get worker balances
        function(keys, callback){
            var redisCommands = keys.map(function(k){
                return ['hget', k, 'balance'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', 'Error with getting balances from redis ' + JSON.stringify(error));
                    callback(true);
                    return;
                }
                var balances = {};
                for (var i = 0; i < replies.length; i++){
                    var parts = keys[i].split(':');
                    var workerId = parts[parts.length - 1];
                    balances[workerId] = parseInt(replies[i]) || 0

                }
                callback(null, balances);
            });
        },

        //Filter workers under balance threshold for payment
        function(balances, callback){

            var redisCommands = [];
            var payments = {};

            for (var worker in balances){
                var balance = balances[worker];
                if (balance >= config.payments.minPayment){
                    var remainder = balance % config.payments.denomination;
                    var payout = balance - remainder;
                    payments[worker] = payout;
                    redisCommands.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -payout]);
                    redisCommands.push(['hincrby', config.coin + ':workers:' + worker, 'paid', payout]);
                }
            }

            if (Object.keys(payments).length === 0){
                log('debug', 'No workers\' balances reached the minimum payment threshold');
                callback(true);
                return;
            }

            var transferCommands = [];

            var transferCommandsLength = Math.ceil(Object.keys(payments).length / config.payments.maxAddresses);

            for (var i = 0; i < transferCommandsLength; i++){
                transferCommands.push({
                    destinations: [],
                    fee: config.payments.transferFee,
                    mixin: 0,
                    unlock_time: 0
                });
            }

            var addresses = 0;
            var commandIndex = 0;

            for (var worker in payments){
                var amount = parseInt(payments[worker]);
                transferCommands[commandIndex].destinations.push({amount: amount, address: worker});

                addresses++;
                if (addresses >= config.payments.maxAddresses){
                    commandIndex++;
                    addresses = 0;
                }
            }


            async.filter(transferCommands, function(transferCmd, cback){
                apiInterfaces.rpcWallet('transfer', transferCmd, function(error, result){
                    if (error){
                        log('error', 'Error with transfer RPC request to wallet daemon '+ JSON.stringify(error));
                        cback(true);
                        return;
                    }
                    log('debug', 'Payments sent ' + JSON.stringify(payments));
                    cback(false);
                });
            }, function(failedCmds){
                if (failedCmds.length === transferCommands.length){
                    return;
                }
                if (failedCmds.length > 0){
                    var failedFileName = 'payments_failed_' + (Date.now() / 1000 | 0) + '.json';
                    fs.writeFile(failedFileName, JSON.stringify(failedCmds), function(err){
                        if (err){
                            log('error', 'Failed to write payment failure data: ' + JSON.stringify(failedCmds));
                            return;
                        }
                        log('error', 'Some payments failed; data logged to ' + failedFileName + ' - must be executed manually');
                    });
                }
                log('debug', 'Payments splintered and ' + (transferCommands.length - failedCmds.length) + ' sent, ' + failedCmds.length + ' failed');
                redisClient.multi(redisCommands).exec(function(error, replies){
                    if (error){
                        log('error', 'Super critical error with payments sending yet failing to be recorded in redis, double payouts likely to happen ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }
                    callback(null);
                });
            });

            callback(null);
        }

    ], function(error, result){
        setTimeout(runInterval, config.payments.interval * 1000);
    });
}

runInterval();