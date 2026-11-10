// E Sepolia 部署脚本：只部署修复版相关合约白名单。
// 白名单：TestToken、SecurePool、PoolShareToken。
// 严禁在本脚本或任何公共网络部署 VulnerablePool 与 contracts/dev。
const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

const SEPOLIA_CHAIN_ID = 11155111n;
const RECORD_PATH = path.join(__dirname, '..', 'docs', 'validation', 'E-deploy-sepolia.json');
const EXPLORER = 'https://sepolia.etherscan.io';
const DEMO_MINT = hre.ethers.parseUnits('1000000', 18); // 仅供测试，无真实价值

async function main() {
  if (hre.network.name !== 'sepolia')
    throw new Error(`deploy-sepolia 只允许 --network sepolia，当前 network=${hre.network.name}`);
  // 先校验环境变量，避免在缺少 RPC/私钥时仍去连接网络。
  if (!process.env.SEPOLIA_RPC_URL)
    throw new Error('缺少 SEPOLIA_RPC_URL（见 .env.example），拒绝在未声明的 RPC 上部署');
  if (!process.env.DEPLOYER_PRIVATE_KEY)
    throw new Error('缺少 DEPLOYER_PRIVATE_KEY（见 .env.example）');

  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== SEPOLIA_CHAIN_ID)
    throw new Error(`链 ID 不是 Sepolia(11155111)，实际 ${network.chainId}`);

  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  if (balance === 0n) throw new Error(`部署账户 ${deployer.address} 没有 Sepolia ETH，请先从水龙头领取`);
  console.log(`部署账户: ${deployer.address}`);
  console.log(`账户余额: ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`网络: ${hre.network.name} (chainId ${network.chainId})`);

  const asset = await hre.ethers.deployContract('TestToken');
  const assetReceipt = await asset.deploymentTransaction().wait();
  const pool = await hre.ethers.deployContract('SecurePool');
  const poolReceipt = await pool.deploymentTransaction().wait();
  const share = await hre.ethers.deployContract('PoolShareToken', [pool.target]);
  const shareReceipt = await share.deploymentTransaction().wait();

  const initTx = await pool.initialize(asset.target, share.target);
  const initReceipt = await initTx.wait();

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

  const mintTx = await asset.mint(deployer.address, DEMO_MINT);
  const mintReceipt = await mintTx.wait();

  const link = (kind, value) => `${EXPLORER}/${kind}/${value}`;
  const record = {
    kind: 'E Sepolia deployment record',
    project: 'DeFi Shield',
    network: 'sepolia',
    chainId: network.chainId.toString(),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      assetToken: { name: 'TestToken', address: asset.target, explorer: link('address', asset.target) },
      securePool: { name: 'SecurePool', address: pool.target, explorer: link('address', pool.target) },
      shareToken: { name: 'PoolShareToken', address: share.target, explorer: link('address', share.target) }
    },
    transactions: {
      deployAssetToken: { hash: assetReceipt.hash, explorer: link('tx', assetReceipt.hash) },
      deploySecurePool: { hash: poolReceipt.hash, explorer: link('tx', poolReceipt.hash) },
      deployShareToken: { hash: shareReceipt.hash, explorer: link('tx', shareReceipt.hash) },
      initialize: { hash: initReceipt.hash, explorer: link('tx', initReceipt.hash) },
      demoMint: { hash: mintReceipt.hash, explorer: link('tx', mintReceipt.hash) }
    },
    verification: checks,
    notes: [
      '仅部署修复版白名单三个合约，未部署 VulnerablePool 与 contracts/dev',
      '测试网资产无真实价值；本记录中的地址与交易可在区块浏览器核验',
      `测试资产 mint 给部署者 ${DEMO_MINT.toString()} 最小单位，便于前端演示`
    ]
  };

  fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true });
  const json = JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  fs.writeFileSync(RECORD_PATH, json + '\n');

  console.log('\n合约地址');
  console.log(`  TestToken       ${asset.target}  ${link('address', asset.target)}`);
  console.log(`  SecurePool      ${pool.target}  ${link('address', pool.target)}`);
  console.log(`  PoolShareToken  ${share.target}  ${link('address', share.target)}`);
  console.log('\n交易');
  console.log(`  deploy TestToken       ${link('tx', assetReceipt.hash)}`);
  console.log(`  deploy SecurePool      ${link('tx', poolReceipt.hash)}`);
  console.log(`  deploy PoolShareToken  ${link('tx', shareReceipt.hash)}`);
  console.log(`  initialize             ${link('tx', initReceipt.hash)}`);
  console.log(`  demo mint              ${link('tx', mintReceipt.hash)}`);
  console.log(`\n部署记录: ${RECORD_PATH}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
