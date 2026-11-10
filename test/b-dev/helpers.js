const { ethers } = require('hardhat');
const { expect } = require('chai');

async function fixture(poolName = 'SecurePool', assetName = 'TestToken', initialize = true) {
  const [admin, alice, bob, eve] = await ethers.getSigners();
  const asset = await ethers.deployContract(assetName);
  const pool = await ethers.deployContract(poolName);
  const share = await ethers.deployContract('PoolShareToken', [pool.target]);
  await Promise.all([asset.waitForDeployment(), pool.waitForDeployment(), share.waitForDeployment()]);
  if (initialize) await (await pool.initialize(asset.target, share.target)).wait();
  for (const user of [alice, bob]) {
    await (await asset.mint(user.address, 1000000n)).wait();
    await (await asset.connect(user).approve(pool.target, ethers.MaxUint256)).wait();
  }
  return { admin, alice, bob, eve, asset, pool, share };
}

async function state(f) {
  const { asset, pool, share, admin, alice, bob, eve } = f;
  const users = [admin, alice, bob, eve];
  return {
    assets: await asset.balanceOf(pool.target), poolBalance: await pool.getPoolBalance(),
    supply: await share.totalSupply(),
    balances: await Promise.all(users.map(u => asset.balanceOf(u.address))),
    shares: await Promise.all(users.map(u => share.balanceOf(u.address))),
    allowances: await Promise.all(users.map(u => asset.allowance(u.address, pool.target))),
    initialized: await pool.initialized(), paused: await pool.paused(),
    owner: await pool.owner(), receipt: await pool.shareToken()
  };
}

async function unchanged(f, action, contract, error) {
  const before = await state(f);
  const start = await ethers.provider.getBlockNumber();
  await expect(action()).to.be.revertedWithCustomError(contract, error);
  expect(await state(f)).to.deep.equal(before);
  const end = await ethers.provider.getBlockNumber();
  if (end > start) {
    expect(await ethers.provider.getLogs({ fromBlock: start + 1, toBlock: end,
      address: [f.asset.target, f.pool.target, f.share.target] })).to.have.length(0);
  }
}

async function move(f, user, method, amount) {
  const before = await state(f);
  const userBefore = await f.asset.balanceOf(user.address);
  const shareBefore = await f.share.balanceOf(user.address);
  await expect(f.pool.connect(user)[method](amount)).to.emit(f.pool,
    method === 'deposit' ? 'Deposited' : 'Redeemed').withArgs(user.address, amount, amount);
  const sign = method === 'deposit' ? 1n : -1n;
  expect(await f.asset.balanceOf(user.address)).to.equal(userBefore - sign * amount);
  expect(await f.share.balanceOf(user.address)).to.equal(shareBefore + sign * amount);
  const after = await state(f);
  expect(after.assets).to.equal(before.assets + sign * amount);
  expect(after.poolBalance).to.equal(after.assets);
  expect(after.supply).to.equal(before.supply + sign * amount);
  expect(after.assets).to.be.gte(after.supply);
  expect(after.shares.reduce((a,b) => a+b, 0n)).to.equal(after.supply);
}
module.exports = { fixture, state, unchanged, move };
