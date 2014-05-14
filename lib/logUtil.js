var dateFormat = require('dateformat');
var colors = require('colors');


var severityToColor = function(severity, text) {
    switch(severity) {
        case 'special':
            return text.cyan.underline;
        case 'debug':
            return text.green;
        case 'warn':
            return text.yellow;
        case 'error':
            return text.red;
        default:
            console.log("Unknown severity " + severity);
            return text.italic;
    }
};

var severityValues = {
    'debug': 1,
    'warn': 2,
    'error': 3,
    'special': 4
};


var PoolLogger = function (configuration) {


    var logLevelInt = severityValues[configuration.logLevel];
    var logColors = configuration.logColors;



    var log = function(severity, system, subsystem, component, text) {

        if (severityValues[severity] < logLevelInt) return;


        var textSystem = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss') + ' [' + system + ']\t';
        var textSubsystem = subsystem ? ('(' + subsystem + ') ') : '';
        var textComponent = component ? ('[' + component + '] ') : '';
        var text = text ? text : '';

        if (logColors) {
            textSystem = severityToColor(severity, textSystem);
            textSubsystem = textSubsystem.bold.grey;
            textComponent = textComponent.italic;
            text = text.grey;
        }

        var logString = textSystem + textSubsystem + textComponent + text;

        console.log(logString);


    };

    // public

    var _this = this;
    Object.keys(severityValues).forEach(function(logType){
        _this[logType] = function(){
            var args = Array.prototype.slice.call(arguments, 0);
            args.unshift(logType);
            log.apply(this, args);
        };
    });
    return this;
};

module.exports = PoolLogger;