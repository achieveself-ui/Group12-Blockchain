const { expect } = require('chai');
const { ethers } = require('hardhat');
const { fixture, unchanged } = require('./helpers');
const { runSequence } = require('../../scripts/b-dev/compare-local');

describe('B development: LOCAL teaching comparison', function () {
  it('16-wei stale-cache underflow is derived, and real test assets are lost', async () => {
    const r = await runSequence('VulnerablePool');
    expect(r.rows[2].poolAssets).to.equal(0);
    expect(r.rows[2].totalSupply).to.equal(0);
    expect(r.rows[2].cachedPoolBalance).to.equal(1000);
    expect(r.rows[3].poolAssets).to.equal(10000);
    expect(r.rows[3].totalSupply).to.equal(10000);
    expect(r.rows[3].cachedPoolBalance).to.equal(11000);
    const minted = (1n<<256n) - 10984n;
    expect(r.minted).to.equal(minted);
    expect(r.rows[4].totalSupply).to.equal(minted+10000n);
    expect(r.rows[4].poolAssets).to.equal(10016);
    expect(r.rows[4].events).to.deep.equal([{name:'Deposited',args:[(await ethers.getSigners())[1].address,16n,minted]}]);
    expect(r.rows[5].poolAssets).to.equal(1);
    expect(r.rows[5].attackerShares).to.equal(0);
    expect(r.rows[5].events[0].args.slice(1)).to.deep.equal([minted,10015n]);
    expect(r.attackerProfit).to.equal(9999);
    expect(r.victimLoss).to.equal(9999);
    expect(r.rows[6].totalSupply).to.equal(0);
    expect(r.rows[6].poolAssets).to.equal(0);
  });

  it('same deposit inputs, redeem-all policy: secure version gives only 16 and zero profit', async () => {
    const r = await runSequence('SecurePool');
    expect(r.minted).to.equal(16);
    expect(r.attackerProfit).to.equal(0);
    expect(r.victimLoss).to.equal(0);
    expect(r.rows[5].poolAssets).to.equal(10000);
    expect(r.rows[4].events[0].args.slice(1)).to.deep.equal([16n,16n]);
    expect(r.rows[5].events[0].args.slice(1)).to.deep.equal([16n,16n]);
    for (const row of r.rows) {
      expect(row.poolAssets).to.equal(row.totalSupply);
      expect(row.totalSupply).to.equal(row.attackerShares+row.victimShares);
    }
  });

  it('outsider can replace vulnerable asset; equivalent call rejected by secure pool', async () => {
    for (const name of ['VulnerablePool','SecurePool']) {
      const f = await fixture(name);
      await f.pool.connect(f.alice).deposit(100);
      const otherAsset = await ethers.deployContract('TestToken');
      if (name === 'SecurePool') {
        await unchanged(f,()=>f.pool.connect(f.eve).initialize(otherAsset.target,f.share.target),f.pool,'OwnableUnauthorizedAccount');
      } else {
        await expect(f.pool.connect(f.eve).initialize(otherAsset.target,f.share.target)).to.emit(f.pool,'Initialized').withArgs(otherAsset.target,f.share.target);
        expect(await f.pool.assetToken()).to.equal(otherAsset.target);
        expect(await f.pool.getPoolBalance()).to.equal(0);
        expect(await f.asset.balanceOf(f.pool.target)).to.equal(100);
        expect(await f.share.totalSupply()).to.equal(100);
        expect(await f.share.balanceOf(f.alice.address)).to.equal(100);
        expect(await f.pool.cachedPoolBalance()).to.equal(0);
      }
    }
  });
});
