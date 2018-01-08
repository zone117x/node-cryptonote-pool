/* global config */

var cnUtil = require('cryptonote-util')

var addressBase58Prefix = cnUtil.address_decode(new Buffer(config.poolServer.poolAddress)) // eslint-disable-line

exports.uid = function () {
  var min = 100000000000000
  var max = 999999999999999
  var id = Math.floor(Math.random() * (max - min + 1)) + min
  return id.toString()
}

exports.ringBuffer = function (maxSize) {
  var data = []
  var cursor = 0
  var isFull = false

  return {
    append: function (x) {
      if (isFull) {
        data[cursor] = x
        cursor = (cursor + 1) % maxSize
      } else {
        data.push(x)
        cursor++
        if (data.length === maxSize) {
          cursor = 0
          isFull = true
        }
      }
    },
    avg: function (plusOne) {
      var sum = data.reduce(function (a, b) { return a + b }, plusOne || 0)
      return sum / ((isFull ? maxSize : cursor) + (plusOne ? 1 : 0))
    },
    size: function () {
      return isFull ? maxSize : cursor
    },
    clear: function () {
      data = []
      cursor = 0
      isFull = false
    }
  }
}

exports.varIntEncode = function (n) {

}

exports.isValidAddress = function (addr) {
    // config.poolServer.poolAddress
    //

  return addressBase58Prefix === cnUtil.address_decode(new Buffer(addr)) // eslint-disable-line
}
