var fs = require('fs');

var redis = require('redis');


var config = JSON.parse(fs.readFileSync('config.json'));

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);

var logger = require('./logUtil.js')({
    logLevel: config.logLevel,
    logColors: config.logColors
});

function log(severity, component, message){
    logger[severity]('Payment Processor', null, component, message);
}


var redisClient = redis.createClient(config.redis.port, config.redis.host);

var batchArray = [
    ['getblockheaderbyheight', {height: 21}],
    ['getblockheaderbyheight', {height: 22}],
    ['getblockheaderbyheight', {height: 23
    }]
];

apiInterfaces.batchRpcDaemon(batchArray, function(error, response){

});

