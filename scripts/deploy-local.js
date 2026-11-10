// E 本地部署脚本：只在 chainId=31337 的 hardhat/localhost 运行。
// 白名单固定为 TestToken、SecurePool、PoolShareToken；不部署 VulnerablePool，
// 也不部署 contracts/dev 下的任何测试合约。
const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

const LOCAL_CHAIN_ID = 31337n;
const RECORD_PATH = path.join(__dirname, '..', 'docs', 'validation', 'E-deploy-local.json');
const DEMO_MINT = hre.ethers.parseUnits('1000000', 18); // 1,000,000 DST（最小单位）
const DEMO_USER_COUNT = 3;

async function assertLocal() {
  const network = await hre.ethers.provider.getNetwork();
  if (!['hardhat', 'localhost'].includes(hre.network.name) || network.chainId !== LOCAL_CHAIN_ID)
    throw new Error(
      `deploy-local 只允许 hardhat/localhost 且 chainId=31337，当前 network=${hre.network.name} chainId=${network.chainId}`
    );
}

function writeRecord(record) {
  fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true });
  const json = JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  fs.writeFileSync(RECORD_PATH, json + '\n');
}

async function main() {
  await assertLocal();

  const signers = await hre.ethers.getSigners();
  if (signers.length < 1 + DEMO_USER_COUNT)
    throw new Error(`本地账户不足：需要部署者 + ${DEMO_USER_COUNT} 个演示账户`);
  const deployer = signers[0];
  const demoUsers = signers.slice(1, 1 + DEMO_USER_COUNT);
  const network = await hre.ethers.provider.getNetwork();

  console.log(`部署者: ${deployer.address}`);
  console.log(`网络: ${hre.network.name} (chainId ${network.chainId})`);

  const asset = await hre.ethers.deployContract('TestToken');
  const assetReceipt = await asset.deploymentTransaction().wait();
  const pool = await hre.ethers.deployContract('SecurePool');
  const poolReceipt = await pool.deploymentTransaction().wait();
  const share = await hre.ethers.deployContract('PoolShareToken', [pool.target]);
  const shareReceipt = await share.deploymentTransaction().wait();

  const initTx = await pool.initialize(asset.target, share.target);
  const initReceipt = await initTx.wait();

  // 部署后校验：地址、绑定、初始化状态、owner、暂停状态、初始供应。
  const checks = {
    initialized: await pool.initialized(),
    assetToken: (await pool.assetToken()).toLowerCase() === asset.target.toLowerCase(),
    shareToken: (await pool.shareToken()).toLowerCase() === share.target.toLowerCase(),
    sharePool: (await share.pool()).toLowerCase() === pool.target.toLowerCase(),
    owner: (await pool.owner()).toLowerCase() === deployer.address.toLowerCase(),
    notPaused: (await pool.paused()) === false,
    zeroSupply: (await share.totalSupply()) === 0n
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) throw new Error(`部署后校验失败: ${failed.join(', ')}`);

  // 演示账户分配：部署者与 3 个演示账户各获得固定数量测试资产。
  const mints = [];
  for (const account of [deployer, ...demoUsers]) {
    const tx = await asset.mint(account.address, DEMO_MINT);
    const receipt = await tx.wait();
    mints.push({ to: account.address, amount: DEMO_MINT.toString(), transactionHash: receipt.hash });
  }

  const record = {
    kind: 'E local deployment record',
    project: 'DeFi Shield',
    network: hre.network.name,
    chainId: network.chainId.toString(),
    ephemeral: hre.network.name === 'hardhat',
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      assetToken: { name: 'TestToken', address: asset.target },
      securePool: { name: 'SecurePool', address: pool.target },
      shareToken: { name: 'PoolShareToken', address: share.target }
    },
    transactions: {
      deployAssetToken: assetReceipt.hash,
      deploySecurePool: poolReceipt.hash,
      deployShareToken: shareReceipt.hash,
      initialize: initReceipt.hash
    },
    verification: checks,
    demoMints: mints,
    demoUsers: demoUsers.map((u) => u.address),
    notes: [
      '1:1 教学模型，金额均为 uint256 最小单位（18 decimals）',
      '本地记录仅在当前链有效；hardhat 内存网络进程结束后地址失效',
      '未部署 VulnerablePool 与 contracts/dev'
    ]
  };
  writeRecord(record);

  console.log('\n合约地址');
  console.log(`  TestToken       ${asset.target}`);
  console.log(`  SecurePool      ${pool.target}`);
  console.log(`  PoolShareToken  ${share.target}`);
  console.log('\n交易哈希');
  console.log(`  deploy TestToken       ${assetReceipt.hash}`);
  console.log(`  deploy SecurePool      ${poolReceipt.hash}`);
  console.log(`  deploy PoolShareToken  ${shareReceipt.hash}`);
  console.log(`  initialize             ${initReceipt.hash}`);
  console.log(`\n演示账户各获得 ${DEMO_MINT.toString()} 最小单位 DST`);
  for (const m of mints) console.log(`  ${m.to}  ${m.transactionHash}`);
  console.log(`\n部署记录: ${RECORD_PATH}`);
  if (record.ephemeral)
    console.log('注意: hardhat 为内存网络，进程结束后本次部署地址全部失效。持久演示请使用 --network localhost。');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { assertLocal };
