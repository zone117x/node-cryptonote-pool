var base58 = require('base58-native');
var cnUtil = require('cryptonote-util');

exports.uid = function(){
    var min = 100000000000000;
    var max = 999999999999999;
    var id = Math.floor(Math.random() * (max - min + 1)) + min;
    return id.toString();
};

exports.ringBuffer = function(maxSize){
    var data = [];
    var cursor = 0;
    var isFull = false;

    return {
        append: function(x){
            if (isFull){
                data[cursor] = x;
                cursor = (cursor + 1) % maxSize;
            }
            else{
                data.push(x);
                cursor++;
                if (data.length === maxSize){
                    cursor = 0;
                    isFull = true;
                }
            }
        },
        avg: function(){
            var sum = data.reduce(function(a, b){ return a + b });
            return sum / (isFull ? maxSize : cursor);
        },
        size: function(){
            return isFull ? maxSize : cursor;
        },
        clear: function(){
            data = [];
            cursor = 0;
            isFull = false;
        }
    };
};

exports.varIntEncode = function(n){

};

exports.isValidAddress = function(addr, prefix){

    if (addr.length !== 95) return false;
    if (addr[0] !== prefix) return false;
    try{
        var decoded = cnUtil.address_decode(new Buffer(addr));
        return decoded.length > 0;
    }
    catch(e){
        return false;
    }

};
