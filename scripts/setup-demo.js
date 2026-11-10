// E 演示数据脚本：在已部署的本地持久链（--network localhost）上准备演示账户。
// 前置：终端 1 运行 npx hardhat node；终端 2 运行 npm run deploy:local。
// 只做 mint / approve / deposit，不发任何交易到公共网络。
const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

const LOCAL_CHAIN_ID = 31337n;
const RECORD_PATH = path.join(__dirname, '..', 'docs', 'validation', 'E-deploy-local.json');
const FUND = hre.ethers.parseUnits('1000000', 18);
const DEMO_USER_COUNT = 3;
const SEED_DEPOSITS = [10000n, 5000n, 2500n]; // 最小单位，与 1:1 教学规则一致

async function main() {
  if (hre.network.name !== 'localhost')
    throw new Error(`setup-demo 需要 --network localhost（持久链），当前 network=${hre.network.name}`);
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== LOCAL_CHAIN_ID)
    throw new Error(`链 ID 必须是 31337，实际 ${network.chainId}`);

  if (!fs.existsSync(RECORD_PATH)) throw new Error(`未找到部署记录 ${RECORD_PATH}，请先运行 npm run deploy:local`);
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8'));
  if (record.chainId !== LOCAL_CHAIN_ID.toString())
    throw new Error(`部署记录 chainId=${record.chainId} 与当前链不一致，请重新部署`);

  const { assetToken, securePool, shareToken } = record.contracts;
  for (const item of [assetToken, securePool, shareToken]) {
    const code = await hre.ethers.provider.getCode(item.address);
    if (code === '0x') throw new Error(`${item.name} 在 ${item.address} 没有代码，部署记录可能已失效`);
  }

  const asset = await hre.ethers.getContractAt('TestToken', assetToken.address);
  const pool = await hre.ethers.getContractAt('SecurePool', securePool.address);
  const share = await hre.ethers.getContractAt('PoolShareToken', shareToken.address);

  if (!(await pool.initialized())) throw new Error('资金池尚未初始化');
  if ((await share.pool()).toLowerCase() !== pool.target.toLowerCase())
    throw new Error('凭证合约未绑定当前资金池');
  if (await pool.paused()) throw new Error('资金池处于暂停状态，请先由 owner 执行 unpause');

  const signers = await hre.ethers.getSigners();
  const demoUsers = signers.slice(1, 1 + DEMO_USER_COUNT);
  const actions = [];

  for (let i = 0; i < demoUsers.length; i += 1) {
    const user = demoUsers[i];
    const balance = await asset.balanceOf(user.address);
    if (balance < FUND) {
      const tx = await asset.mint(user.address, FUND - balance);
      const receipt = await tx.wait();
      actions.push({ user: user.address, action: 'mint', amount: (FUND - balance).toString(), transactionHash: receipt.hash });
    }

    const deposit = SEED_DEPOSITS[i];
    const allowance = await asset.allowance(user.address, pool.target);
    if (allowance < deposit) {
      const tx = await asset.connect(user).approve(pool.target, hre.ethers.MaxUint256);
      const receipt = await tx.wait();
      actions.push({ user: user.address, action: 'approve', amount: 'MaxUint256', transactionHash: receipt.hash });
    }

    if ((await share.balanceOf(user.address)) === 0n) {
      const tx = await pool.connect(user).deposit(deposit);
      const receipt = await tx.wait();
      actions.push({ user: user.address, action: 'deposit', amount: deposit.toString(), transactionHash: receipt.hash });
    }
  }

  console.log('演示账户状态');
  for (const user of demoUsers) {
    const assets = await asset.balanceOf(user.address);
    const shares = await share.balanceOf(user.address);
    console.log(`  ${user.address}  资产 ${assets}  凭证 ${shares}`);
  }
  console.log(`\n池内资产: ${await pool.getPoolBalance()}`);
  console.log(`凭证总量: ${await share.totalSupply()}`);
  console.log(`暂停状态: ${await pool.paused()}`);
  console.log('\n本次动作');
  if (actions.length === 0) console.log('  无需变更（演示数据已就绪）');
  for (const a of actions)
    console.log(`  ${a.user}  ${a.action} ${a.amount}  交易 ${a.transactionHash}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
