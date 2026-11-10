require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');
// Use the locked npm solc-js, without a separate compiler download.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, hre, runSuper) => {
  if (solcVersion !== '0.8.24') return runSuper();
  return { compilerPath: require.resolve('solc/soljson.js'), isSolcJs: true,
    version: solcVersion, longVersion: require('solc').version() };
});
// E: 只有 SEPOLIA_RPC_URL / DEPLOYER_PRIVATE_KEY 存在时才注册账户；
// 缺省时其他命令（compile/test/本地部署）不受影响。
function sepoliaAccounts() {
  const raw = (process.env.DEPLOYER_PRIVATE_KEY || '').trim();
  if (!raw) return [];
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw))
    throw new Error('DEPLOYER_PRIVATE_KEY 必须是 0x 开头的 32 字节十六进制私钥');
  return [raw];
}

module.exports = {
  solidity: { version: '0.8.24', settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' } },
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: 'http://127.0.0.1:8545', chainId: 31337 },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || 'https://sepolia.drpc.org',
      chainId: 11155111,
      accounts: sepoliaAccounts()
    }
  },
  mocha: { timeout: 120000 }
};
