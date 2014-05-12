var fs = require('fs');
var cluster = require('cluster');

////simplewallet --wallet-file=wallet.bin --pass=test --rpc-bind-port=8082

if (cluster.isWorker){
    switch(process.env.workerType){
        case 'pool':
            require('./pool.js');
            break;
        case 'paymentProcessor':
            require('./paymentProcessor.js');
            break;
        case 'api':
            require('./api.js');
            break;
        case 'cli':
            require('./cli.js');
            break
    }
    return;
}

var config = JSON.parse(fs.readFileSync('config.json'));

var logger = require('./logUtil.js')({
    logLevel: config.logLevel,
    logColors: config.logColors
});

var logSystem = 'Master';
var logSubsystem = null;

var os = require('os');

(function init(){
    spawnPoolWorkers();
    spawnPaymentProcessor();
    spawnApi();
    spawnCli();
})();


function spawnPoolWorkers(){

    var numForks = (function(){
        if (!config.clusterForks)
            return 1;
        if (config.clusterForks === 'auto')
            return os.cpus().length;
        if (isNaN(config.clusterForks))
            return 1;
        return config.clusterForks;
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
            //severity, system, subsystem, component, text
            logger.error(logSystem, logSubsystem, 'Pool Spawner', 'Fork ' + forkId + ' died, spawning replacement worker...');
            setTimeout(function(){
                createPoolWorker(forkId);
            }, 2000);
        }).on('message', function(msg){
            switch(msg.type){
                case 'none':
                    break;
            }
        });
    };

    var i = 0;
    var spawnInterval = setInterval(function(){
        createPoolWorker(i);
        i++;
        if (i === numForks){
            clearInterval(spawnInterval);
            logger.debug(logSystem, logSubsystem, 'Pool Spawner', 'Spawned pool on ' + numForks + ' thread(s)');
        }
    }, 10);
}

function spawnPaymentProcessor(){
    var worker = cluster.fork({
        workerType: 'paymentProcessor'
    });
    worker.on('exit', function(code, signal){
        logger.error(logSystem, logSubsystem, 'Payment Processor', 'Payment processor died, spawning replacement...');
        setTimeout(function(){
            spawnPaymentProcessor();
        }, 2000);
    });
}

function spawnApi(){

}

function spawnCli(){

}