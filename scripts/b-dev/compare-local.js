const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

async function assertLocal() {
  if (hre.network.name !== 'hardhat' || (await hre.ethers.provider.getNetwork()).chainId !== 31337n)
    throw new Error('B demonstration is allowed only on the ephemeral Hardhat network (31337).');
}

async function runSequence(name) {
  await assertLocal();
  const [admin, attacker, victim] = await hre.ethers.getSigners();
  const asset = await hre.ethers.deployContract('TestToken');
  const pool = await hre.ethers.deployContract(name);
  const share = await hre.ethers.deployContract('PoolShareToken',[pool.target]);
  await Promise.all([asset.waitForDeployment(),pool.waitForDeployment(),share.waitForDeployment()]);
  const initialize = await pool.initialize(asset.target,share.target);
  await initialize.wait();
  for (const u of [attacker,victim]) {
    await (await asset.mint(u.address,20000)).wait();
    await (await asset.connect(u).approve(pool.target,hre.ethers.MaxUint256)).wait();
  }
  const rows = [];
  async function snapshot(step,receipt) {
    rows.push({ step, attackerAssets: await asset.balanceOf(attacker.address),
      victimAssets: await asset.balanceOf(victim.address), attackerShares: await share.balanceOf(attacker.address),
      victimShares: await share.balanceOf(victim.address), poolAssets: await pool.getPoolBalance(),
      totalSupply: await share.totalSupply(), cachedPoolBalance: name === 'VulnerablePool' ? await pool.cachedPoolBalance() : null,
      transactionHash: receipt?.hash ?? null,
      events: receipt ? receipt.logs.flatMap(log => {
        try { const e = pool.interface.parseLog(log); return e ? [{name:e.name,args:Array.from(e.args)}] : []; }
        catch { return []; }
      }) : [] });
  }
  async function act(user,method,amount,label) {
    const receipt = await (await pool.connect(user)[method](amount)).wait();
    await snapshot(label,receipt);
  }
  await snapshot('initial');
  await act(attacker,'deposit',1000n,'seed deposit 1000');
  await act(attacker,'redeem',1000n,'empty pool');
  await act(victim,'deposit',10000n,'victim deposit 10000');
  await act(attacker,'deposit',16n,'attacker deposit 16');
  const minted = await share.balanceOf(attacker.address);
  await act(attacker,'redeem',minted,'attacker redeem all own shares');
  await act(victim,'redeem',10000n,'victim redeem all own shares');
  return { name, chainId:31337, ephemeral:true,
    addresses:{asset:asset.target,pool:pool.target,share:share.target},
    deploymentTransactions:{asset:asset.deploymentTransaction().hash,pool:pool.deploymentTransaction().hash,share:share.deploymentTransaction().hash,initialize:initialize.hash},
    rows, minted, attackerProfit:await asset.balanceOf(attacker.address)-20000n,
    victimLoss:20000n-await asset.balanceOf(victim.address) };
}

async function main() {
  const results = [];
  for (const name of ['VulnerablePool','SecurePool']) results.push(await runSequence(name));
  const report = {kind:'B development validation, not E deployment delivery', results};
  const json = JSON.stringify(report,(_,v)=>typeof v === 'bigint' ? v.toString():v,2);
  const output = path.join(__dirname,'../../docs/validation/B-comparison.json');
  fs.writeFileSync(output,json+'\n');
  console.log(json);
}
if (require.main === module) main().catch(e=>{ console.error(e); process.exitCode=1; });
module.exports = { runSequence, assertLocal };
