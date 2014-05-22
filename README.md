node-cryptonote-pool
====================

High performance Node.js (with native C addons) mining pool for CryptoNote based coins such as Bytecoin, Monero, QuazarCoin, Fantomcoin, HoneyPenny, etc..
Comes with lightweight example front-end script which uses the pool's AJAX API.



#### Table of Contents
* [Features](#features)
* [Under Development](#under-development)
* [Community Support](#community--support)
* [Pools Using This Software](#pools-using-this-software)
* [Usage](#usage)
  * [Requirements](#requirements)
  * [Downloading & Installing](#1-downloading--installing)
  * [Configuration](#2-configuration)
  * [Configure Easyminer](#3-options-configure-cryptonote-easy-miner-for-your-pool)
  * [Starting the Pool](#4-start-the-pool)
  * [Upgrading](#upgrading)
* [Setting up Testnet](#setting-up-testnet)
* [JSON-RPC Commands from CLI](#json-rpc-commands-from-cli)
* [Monitoring Your Pool](#monitoring-your-pool)
* [Donations](#donations)
* [Credits](#credits)
* [License](#license)


#### Features

* IP banning to prevent low-diff share attacks
* Socket flooding detection
* Payment processing
* Detailed logging
* Ability to configure multiple ports - each with their own difficulty
* Variable difficulty / share limiter
* Share trust algorithm to reduce share validation hashing CPU load
* Clustering for vertical scaling
* Modular components for horizontal scaling (pool server, database, stats/API, payment processing, front-end)
* Live stats API (using CORS with AJAX and HTML5 EventSource)
  * Currency network/block difficulty
  * Current block height
  * Network hashrate
  * Pool hashrate
  * Each miners' individual stats (hashrate, shares submitted, total paid, etc)
  * Blocks found (pending, confirmed, and orphaned)
* An easily extendable, responsive, light-weight front-end using API to display data
* Worker login validation (make sure miners are using proper wallet addresses for mining)


#### Under Development

* Stratum protocol (push-based TCP sockets) to help reduce server load

### Community / Support

* [CryptoNote Forum](https://forum.cryptonote.org/)
* [Bytecoin Github](https://github.com/amjuarez/bytecoin)
* [Monero Github](https://github.com/monero-project/bitmonero)
* IRC (freenode)
  * Support / general discussion join #monero: https://webchat.freenode.net/?channels=#monero
  * Development discussion join #monero-dev: https://webchat.freenode.net/?channels=#monero-dev


#### Pools Using This Software

* http://moneropool.org
* http://moneropool.com
* http://extremepool.org
* http://mon.hashharder.com


Usage
===

#### Requirements
* Coin daemon(s) (find the coin's repo and build latest version from source)
* [Node.js](http://nodejs.org/) v0.10+ ([follow these installation instructions](https://github.com/joyent/node/wiki/Installing-Node.js-via-package-manager))
* [Redis](http://redis.io/) key-value store v2.6+ ([follow these instructions](http://redis.io/topics/quickstart))

##### Seriously
Those are legitimate requirements. If you use old versions of Node.js or Redis that may come with your system package manager then you will have problems. Follow the linked instructions to get the last stable versions.


[**Redis security warning**](http://redis.io/topics/security): be sure firewall access to redis - an easy way is to
include `bind 127.0.0.1` in your `redis.conf` file. Also it's a good idea to learn about and understand software that
you are using - a good place to start with redis is [data persistence](http://redis.io/topics/persistence).


#### 1) Downloading & Installing

Clone the repository and run `npm update` for all the dependencies to be installed:

```bash
git clone https://github.com/zone117x/node-cryptonote-pool.git pool
cd pool
npm update
```

#### 2) Configuration

Copy the `config_example.json` file to `config.json` then overview each options and change any to match your preferred setup.


Explanation for each field:
```javascript
{
    /* Used for storage in redis so multiple coins can share the same redis instance. */
    "coin": "monero",

    /* Used for front-end display */
    "symbol": "MRO",

    "coinUnits": 100000000,
    "transferFee": 1000000,

    /* Host that simpleminer is pointed to.  */
    "poolHost": "example.com",

    /* IRC Server and room used for embedded KiwiIRC chat on fron-end. */
    "irc": "irc.freenode.net/#monero",

    /* Contact email address. */
    "email": "support@cryppit.com",

    /* Address where block rewards go, and miner payments come from. */
    "poolAddress": "4AsBy39rpUMTmgTUARGq2bFQWhDhdQNekK5v4uaLU699NPAnx9CubEJ82AkvD5ScoAZNYRwBxybayainhyThHAZWCdKmPYn"

    /* Modular Pool Server */
    "poolServer": {
        "enabled": true,
        "ports": [
            {
                "port": 3333, //Port for mining apps to connect to
                "difficulty": 50, //Initial difficulty miners are set to
                "desc": "Low end CPUs" //Description of port
            },
            {
                "port": 5555,
                "difficulty": 200,
                "desc": "Mid range CPUs"
            },
            {
                "port": 7777,
                "difficulty": 2000,
                "desc": "High end CPUs"
            }
        ],

        /* Variable difficulty is a feature that will automatically adjust difficulty for
           individual miners based on their hashrate in order to lower networking and CPU
           overhead. */
        "varDiff": {
            "minDiff": 2, //Minimum difficulty
            "maxDiff": 10000,
            "targetTime": 100, //Try to get 1 share per this many seconds
            "retargetTime": 30, //Check to see if we should retarget every this many seconds
            "variancePercent": 30, //Allow time to very this % from target without retargeting
            "maxJump": 1000 //Limit how much diff can increase/decrease in a single retargetting
        },

        /* Feature to trust share difficulties from miners which can significantly reduce CPU load. */
        "shareTrust": {
            "enabled": true,
            "min": 10, //Minimum percent probability for share hashing
            "stepDown": 3, //Increase trust probability percent this much with each valid share
            "threshold": 10, //Amount of valid shares required before trusting begins
            "penalty": 30 //Upon breaking trust require this many valid share before re-trusting
        }
    },

    /* Market display widget params from https://www.cryptonator.com/widget */
    "cryptonatorWidget": "num=2&base_0=Monero%20(MRO)&target_0=Bitcoin%20(BTC)&base_1=Monero%20(MRO)&target_1=US%20Dollar%20(USD)",

    /* Download link to cryptonote-easy-miner for Windows users. */
    "easyminerDownload": "https://github.com/zone117x/cryptonote-easy-miner/raw/master/CryptoNoteMiner/bin/Release/cryptnote-easy-miner-latest.zip",

    /* Used for front-end block links. For other coins it can be changed, for example with
       Bytecoin you can use "https://minergate.com/blockchain/bcn/block/". */
    "blockchainExplorer": "http://monerochain.info/block/",

    /* Set to "auto" by default which will spawn one process/fork/worker for each CPU
       core in your system. Each of these workers will run a separate instance of your pool(s),
       and the kernel will load balance miners using these forks. Optionally, the 'forks' field
       can be a number for how many forks will be spawned. */
    "clusterForks": "auto",

    /* Specifies the level of log output verbosity. Anything more severe than the level specified
       will also be logged. */
    "logLevel": "debug", //or "warn", "error"

    /* By default the pool logs to console and gives pretty colors. If you direct that output to a
       log file then disable this feature to avoid nasty characters in your log file. */
    "logColors": true,

    /* Poll RPC daemons for new blocks every this many milliseconds. */
    "blockRefreshInterval": 1000,

    /* How many seconds until we consider a miner disconnected. */
    "minerTimeout": 900,

    /* Only works with the new simpleminer with longpolling enabled. */
    "longPolling": {
        "enabled": true,
        "timeout": 8500
    },

    /* If under low-diff share attack we can ban their IP to reduce system/network load. */
    "banning": {
        "enabled": true,
        "time": 600, //How many seconds to ban worker for
        "invalidPercent": 25, //What percent of invalid shares triggers ban
        "checkThreshold": 30 //Perform check when this many shares have been submitted
    },

    /* Module that sends payments to miners according to their submitted shares. */
    "payments": {
        "enabled": true,
        "interval": 30, //how often to run in seconds
        "poolFee": 2, //2% pool fee
        "depth": 60, //block depth required to send payments (CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW)
        "maxAddresses": 50 //split up payments if sending to more than this many addresses
    }

    /* AJAX/EventSource API used for front-end website. */
    "api": {
        "enabled": true,
        "hashrateWindow": 600, //how many second worth of shares used to estimate hash rate
        "updateInterval": 3, //gather stats and broadcast every this many seconds
        "port": 8117
    },

    /* Coin daemon connection details. */
    "daemon": {
        "host": "127.0.0.1",
        "port": 18081
    },

    /* Wallet daemon connection details. */
    "wallet": {
        "host": "127.0.0.1",
        "port": 8082
    },

    /* Redis connection into. */
    "redis": {
        "host": "127.0.0.1",
        "port": 6379
    }
}
```

#### 3) [Options] Configure cryptonote-easy-miner for your pool
Your miners that are Windows users can use [cryptonote-easy-miner](https://github.com/zone117x/cryptonote-easy-miner)
which will automatically generate their wallet address and stratup multiple threads of simpleminer. You can download
it and edit the `config.ini` file to point to your own pool.
Inside the `easyminer` folder, edit `config.init` to point to your pool details
```ini
pool_host=example.com
pool_port=5555
```

Rezip and upload to your server or a file host. Then change the `easyminerDownload` link in your `config.json` file to
point to your zip file.

#### 4) Start the pool

```bash
node init.js
```


#### 5) Host the front-end

Edit `index.html` to use your pool API configuration

```html
    <script>

        var api = 'http://poolhost:8117';

    </script>
```

Then simply serve the file via nginx, Apache, Google Drive, or anything that can host static content.


#### Upgrading
When updating to the latest code its important to not only `git pull` the latest from this repo, but to also update
the Node.js modules, and any config files that may have been changed.
* Inside your pool directory (where the init.js script is) do `git pull` to get the latest code.
* Remove the dependencies by deleting the `node_modules` directory with `rm -r node_modules`.
* Run `npm update` to force updating/reinstalling of the dependencies.
* Compare your `config.json` to the latest example ones in this repo or the ones in the setup instructions where each config field is explained. You may need to modify or add any new changes.

### Setting up Testnet

No cryptonote based coins have a testnet mode (yet) but you can effectively create a testnet with the following steps:

* Open `/src/p2p/net_node.inl` and remove lines with `ADD_HARDCODED_SEED_NODE` to prevent it from connecting to mainnet (Monero example: http://git.io/0a12_Q)
* Build the coin from source
* You now need to run two instance of the daemon and connect them to each other (without a connection to another instance the daemon will not accept RPC requests)
  * Run first instance with `./coind --p2p-bind-port 28080 --allow-local-ip`
  * Run second instance with `./coind --p2p-bind-port 5011 --rpc-bind-port 5010 --add-peer 0.0.0.0:28080 --allow-local-ip`
* You should now have a local testnet setup. The ports can be changes as long as the second instance is pointed to the first instance, obviously

*Credit to surfer43 for these instructions*


### JSON-RPC Commands from CLI

Documentation for JSON-RPC commands can be found here:
* Daemon https://wiki.bytecoin.org/wiki/Daemon_JSON_RPC_API
* Wallet https://wiki.bytecoin.org/wiki/Wallet_JSON_RPC_API


Curl can be used to use the JSON-RPC commands from command-line. Here is an example of calling `getblockheaderbyheight` for block 100:

```bash
curl -X POST http://127.0.0.1:18081/json_rpc -d '{"jsonrpc":"2.0","id":"test","method":"getblockheaderbyheight","params":{"height":100}}'
```


### Monitoring Your Pool

* To inspect and make changes to redis I suggest using [redis-commander](https://github.com/joeferner/redis-commander)
* To monitor server load for CPU, Network, IO, etc - I suggest using [New Relic](http://newrelic.com/)
* To keep your pool node script running in background, logging to file, and automatically restarting if it crashes - I suggest using [forever](https://github.com/nodejitsu/forever)


Donations
---------
* MRO: `48Y4SoUJM5L3YXBEfNQ8bFNsvTNsqcH5Rgq8RF7BwpgvTBj2xr7CmWVanaw7L4U9MnZ4AG7U6Pn1pBhfQhFyFZ1rL1efL8z`
* BCN: `asdf`

Credits
===

* [LucasJones](//github.com/LucasJones) - Co-dev on this project; did tons of debugging for binary structures and fixing them. Pool couldn't have been made without him.
* [surfer43](//github.com/iamasupernova) - Did lots of testing during development to help figure out bugs and get them fixed
* [Wolf0](https://bitcointalk.org/index.php?action=profile;u=80740) - Helped try to deobfuscate some of the daemon code for getting a bug fixed
* [Tacotime](https://bitcointalk.org/index.php?action=profile;u=19270) - helping with figuring out certain problems and lead the bounty for this project's creation

License
-------
Released under the GNU General Public License v2

http://www.gnu.org/licenses/gpl-2.0.html
