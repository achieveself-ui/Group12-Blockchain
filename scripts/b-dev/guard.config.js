const path = require('path');
const base = require('../../hardhat.config');
module.exports = { ...base, networks:{hardhat:{chainId:1}},
  paths:{root:path.resolve(__dirname,'../..')} };
