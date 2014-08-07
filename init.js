var fs = require('fs');
var cluster = require('cluster');
var os = require('os');

var redis = require('redis');


require('./lib/configReader.js');

require('./lib/logger.js');


global.redisClient = redis.createClient(config.redis.port, config.redis.host);


if (cluster.isWorker){
    switch(process.env.workerType){
        case 'pool':
            require('./lib/pool.js');
            break;
        case 'blockUnlocker':
            require('./lib/blockUnlocker.js');
            break;
        case 'paymentProcessor':
            require('./lib/paymentProcessor.js');
            break;
        case 'api':
            require('./lib/api.js');
            break;
        case 'cli':
            require('./lib/cli.js');
            break
        case 'chartsDataCollector':
            require('./lib/chartsDataCollector.js');
            break

    }
    return;
}

var logSystem = 'master';
require('./lib/exceptionWriter.js')(logSystem);


var singleModule = (function(){

    var validModules = ['pool', 'api', 'unlocker', 'payments', 'chartsDataCollector'];

    for (var i = 0; i < process.argv.length; i++){
        if (process.argv[i].indexOf('-module=') === 0){
            var moduleName = process.argv[i].split('=')[1];
            if (validModules.indexOf(moduleName) > -1)
                return moduleName;

            log('error', logSystem, 'Invalid module "%s", valid modules: %s', [moduleName, validModules.join(', ')]);
            process.exit();
        }
    }
})();


(function init(){

    checkRedisVersion(function(){

        if (singleModule){
            log('info', logSystem, 'Running in single module mode: %s', [singleModule]);

            switch(singleModule){
                case 'pool':
                    spawnPoolWorkers();
                    break;
                case 'unlocker':
                    spawnBlockUnlocker();
                    break;
                case 'payments':
                    spawnPaymentProcessor();
                    break;
                case 'api':
                    spawnApi();
                    break;
                case 'chartsDataCollector':
                    spawnChartsDataCollector();
                    break;
            }
        }
        else{
            spawnPoolWorkers();
            spawnBlockUnlocker();
            spawnPaymentProcessor();
            spawnApi();
            spawnChartsDataCollector();
        }

        spawnCli();

    });
})();


function checkRedisVersion(callback){

    redisClient.info(function(error, response){
        if (error){
            log('error', logSystem, 'Redis version check failed');
            return;
        }
        var parts = response.split('\r\n');
        var version;
        var versionString;
        for (var i = 0; i < parts.length; i++){
            if (parts[i].indexOf(':') !== -1){
                var valParts = parts[i].split(':');
                if (valParts[0] === 'redis_version'){
                    versionString = valParts[1];
                    version = parseFloat(versionString);
                    break;
                }
            }
        }
        if (!version){
            log('error', logSystem, 'Could not detect redis version - must be super old or broken');
            return;
        }
        else if (version < 2.6){
            log('error', logSystem, "You're using redis version %s the minimum required version is 2.6. Follow the damn usage instructions...", [versionString]);
            return;
        }
        callback();
    });
}

function spawnPoolWorkers(){

    if (!config.poolServer || !config.poolServer.enabled || !config.poolServer.ports || config.poolServer.ports.length === 0) return;

    if (config.poolServer.ports.length === 0){
        log('error', logSystem, 'Pool server enabled but no ports specified');
        return;
    }


    var numForks = (function(){
        if (!config.poolServer.clusterForks)
            return 1;
        if (config.poolServer.clusterForks === 'auto')
            return os.cpus().length;
        if (isNaN(config.poolServer.clusterForks))
            return 1;
        return config.poolServer.clusterForks;
    })();

    var poolWorkers = {};

    var createPoolWorker = function(forkId){
        var worker = cluster.fork({
            workerType: 'pool',
            forkId: forkId
        });
        worker.forkId = forkId;
        worker.type = 'pool';
        poolWorkers[forkId] = worker;
        worker.on('exit', function(code, signal){
            log('error', logSystem, 'Pool fork %s died, spawning replacement worker...', [forkId]);
            setTimeout(function(){
                createPoolWorker(forkId);
            }, 2000);
        }).on('message', function(msg){
            switch(msg.type){
                case 'banIP':
                    Object.keys(cluster.workers).forEach(function(id) {
                        if (cluster.workers[id].type === 'pool'){
                            cluster.workers[id].send({type: 'banIP', ip: msg.ip});
                        }
                    });
                    break;
            }
        });
    };

    var i = 1;
    var spawnInterval = setInterval(function(){
        createPoolWorker(i.toString());
        i++;
        if (i - 1 === numForks){
            clearInterval(spawnInterval);
            log('info', logSystem, 'Pool spawned on %d thread(s)', [numForks]);
        }
    }, 10);
}

function spawnBlockUnlocker(){

    if (!config.blockUnlocker || !config.blockUnlocker.enabled) return;

    var worker = cluster.fork({
        workerType: 'blockUnlocker'
    });
    worker.on('exit', function(code, signal){
        log('error', logSystem, 'Block unlocker died, spawning replacement...');
        setTimeout(function(){
            spawnBlockUnlocker();
        }, 2000);
    });

}

function spawnPaymentProcessor(){

    if (!config.payments || !config.payments.enabled) return;

    var worker = cluster.fork({
        workerType: 'paymentProcessor'
    });
    worker.on('exit', function(code, signal){
        log('error', logSystem, 'Payment processor died, spawning replacement...');
        setTimeout(function(){
            spawnPaymentProcessor();
        }, 2000);
    });
}

function spawnApi(){
    if (!config.api || !config.api.enabled) return;

    var worker = cluster.fork({
        workerType: 'api'
    });
    worker.on('exit', function(code, signal){
        log('error', logSystem, 'API died, spawning replacement...');
        setTimeout(function(){
            spawnApi();
        }, 2000);
    });
}

function spawnCli(){

}

function spawnChartsDataCollector(){
    if (!config.charts) return;

    var worker = cluster.fork({
        workerType: 'chartsDataCollector'
    });
    worker.on('exit', function(code, signal){
        log('error', logSystem, 'chartsDataCollector died, spawning replacement...');
        setTimeout(function(){
            spawnChartsDataCollector();
        }, 2000);
    });
}
