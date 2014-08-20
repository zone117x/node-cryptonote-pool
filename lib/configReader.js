var fs = require('fs');

var configFile = (function(){
    for (var i = 0; i < process.argv.length; i++){
        if (process.argv[i].indexOf('-config=') === 0)
            return process.argv[i].split('=')[1];
    }
    return 'config.json';
})();


try {
    global.config = JSON.parse(fs.readFileSync(configFile));
}
catch(e){
    console.error('Failed to read config file ' + configFile + '\n\n' + e);
    return;
}

global.version = "v0.99.3.2";
global.devDonationAddress = '1JYa1g52PN5aAq9gjTiDkwWc2Zu56ZkTUV49De8EuSFd9bQcSoRaGvdcJ3dut3XULBbAWqKassGp4Yr6PYodQpbsUKdGUtq';
global.coreDevDonationAddress = '1KfzJfoA2pbB6J2ee2JG7wYSqwKtdoqs97pVMdB471FXArr1ce52Wm1BCWdAv9JAxZTa7wcUkq2s695Nmn59HgZ6VVnSjfp';
global.doDonations =  devDonationAddress[0] === config.poolServer.poolAddress[0] && (
    config.blockUnlocker.devDonation > 0 || config.blockUnlocker.coreDevDonation > 0
);