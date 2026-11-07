const { expect } = require('chai');
const { ethers } = require('hardhat');
const { fixture, state, unchanged, move } = require('./helpers');

describe('B development: SecurePool and tokens', function () {
  let f;
  beforeEach(async () => { f = await fixture(); });

  it('owner initializes once; outsider cannot front-run; uninitialized queries work', async () => {
    f = await fixture('SecurePool', 'TestToken', false);
    expect(await f.pool.getPoolBalance()).to.equal(0n);
    expect(await f.pool.shareToken()).to.equal(ethers.ZeroAddress);
    await unchanged(f, () => f.pool.connect(f.eve).initialize(f.asset.target, f.share.target), f.pool, 'OwnableUnauthorizedAccount');
    for (const method of ['deposit', 'redeem'])
      await unchanged(f, () => f.pool.connect(f.alice)[method](1), f.pool, 'NotInitialized');
    await expect(f.pool.initialize(f.asset.target, f.share.target)).to.emit(f.pool, 'Initialized').withArgs(f.asset.target, f.share.target);
    expect(await f.pool.initialized()).to.equal(true);
    expect(await f.pool.owner()).to.equal(f.admin.address);
    await unchanged(f, () => f.pool.initialize(f.asset.target, f.share.target), f.pool, 'AlreadyInitialized');
  });

  it('rejects zero, EOA, identical tokens, wrong pool binding and unsupported decimals', async () => {
    f = await fixture('SecurePool', 'TestToken', false);
    for (const [a,s] of [[ethers.ZeroAddress,f.share.target],[f.asset.target,ethers.ZeroAddress],
      [f.eve.address,f.share.target],[f.asset.target,f.eve.address],[f.asset.target,f.asset.target]])
      await unchanged(f, () => f.pool.initialize(a,s), f.pool, 'InvalidToken');
    const other = await ethers.deployContract('SecurePool');
    const wrong = await ethers.deployContract('PoolShareToken', [other.target]);
    await unchanged(f, () => f.pool.initialize(f.asset.target, wrong.target), f.pool, 'InvalidShareToken');
    const six = await ethers.deployContract('SixDecimalAsset');
    await unchanged(f, () => f.pool.initialize(six.target, f.share.target), f.pool, 'UnsupportedDecimals');
    await expect(ethers.deployContract('PoolShareToken',[ethers.ZeroAddress])).to.be.revertedWithCustomError(f.share,'InvalidPool');
    await expect(ethers.deployContract('PoolShareToken',[f.eve.address])).to.be.revertedWithCustomError(f.share,'InvalidPool');
  });

  it('first/subsequent deposits, partial/full redemption, multiuser and immediate roundtrip', async () => {
    await move(f,f.alice,'deposit',1000n);
    await move(f,f.bob,'deposit',500n);
    await move(f,f.alice,'redeem',400n);
    const before = await state(f);
    await move(f,f.bob,'deposit',123n);
    await move(f,f.bob,'redeem',123n);
    expect(await state(f)).to.deep.equal(before);
    await move(f,f.alice,'redeem',600n);
    await move(f,f.bob,'redeem',500n);
    expect(await f.pool.initialized()).to.equal(true);
    await move(f,f.alice,'deposit',16n);
    await unchanged(f,()=>f.pool.initialize(f.asset.target,f.share.target),f.pool,'AlreadyInitialized');
  });

  it('zero, missing allowance, insufficient assets/shares and max input revert atomically', async () => {
    for (const method of ['deposit','redeem'])
      await unchanged(f,()=>f.pool.connect(f.alice)[method](0),f.pool,'ZeroAmount');
    await f.asset.mint(f.eve.address,100);
    await unchanged(f,()=>f.pool.connect(f.eve).deposit(1),f.asset,'ERC20InsufficientAllowance');
    await unchanged(f,()=>f.pool.connect(f.alice).deposit(1000001),f.asset,'ERC20InsufficientBalance');
    await unchanged(f,()=>f.pool.connect(f.alice).deposit(ethers.MaxUint256),f.asset,'ERC20InsufficientBalance');
    await unchanged(f,()=>f.pool.connect(f.alice).redeem(1),f.pool,'InsufficientShares');
    await move(f,f.alice,'deposit',1n);
    await unchanged(f,()=>f.pool.connect(f.alice).redeem(2),f.pool,'InsufficientShares');
  });

  it('only pool may mint/burn receipts; only owner may mint test assets', async () => {
    await move(f,f.alice,'deposit',10n);
    for (const u of [f.admin,f.eve]) {
      await unchanged(f,()=>f.share.connect(u).mint(u.address,1),f.share,'OnlyPool');
      await unchanged(f,()=>f.share.connect(u).burn(f.alice.address,1),f.share,'OnlyPool');
    }
    await unchanged(f,()=>f.asset.connect(f.eve).mint(f.eve.address,1),f.asset,'OwnableUnauthorizedAccount');
  });

  it('pause permissions/events/queries, repeated pause errors, resume', async () => {
    await move(f,f.alice,'deposit',10n);
    for (const method of ['pause','unpause'])
      await unchanged(f,()=>f.pool.connect(f.eve)[method](),f.pool,'OwnableUnauthorizedAccount');
    await expect(f.pool.pause()).to.emit(f.pool,'Paused').withArgs(f.admin.address);
    expect(await f.pool.paused()).to.equal(true);
    await unchanged(f,()=>f.pool.pause(),f.pool,'EnforcedPause');
    for (const method of ['deposit','redeem'])
      await unchanged(f,()=>f.pool.connect(f.alice)[method](1),f.pool,'EnforcedPause');
    expect(await f.pool.getPoolBalance()).to.equal(10);
    expect(await f.pool.shareToken()).to.equal(f.share.target);
    expect(await f.pool.initialized()).to.equal(true);
    expect(await f.pool.owner()).to.equal(f.admin.address);
    await expect(f.pool.unpause()).to.emit(f.pool,'Unpaused').withArgs(f.admin.address);
    await unchanged(f,()=>f.pool.unpause(),f.pool,'ExpectedPause');
    await move(f,f.alice,'deposit',1n);
    await move(f,f.alice,'redeem',11n);
    expect(f.pool.interface.getEvent('Paused').inputs[0].indexed).to.equal(false);
    expect(f.pool.interface.getEvent('Unpaused').inputs[0].indexed).to.equal(false);
    expect(f.pool.interface.getEvent('Deposited').inputs.map(x=>x.indexed)).to.deep.equal([true,false,false]);
  });

  it('donations leave fixed 1:1 intact and receipts remain transferable', async () => {
    await f.asset.connect(f.bob).transfer(f.pool.target,77);
    await move(f,f.alice,'deposit',100n);
    await expect(f.share.connect(f.alice).transfer(f.bob.address,40)).to.emit(f.share,'Transfer').withArgs(f.alice.address,f.bob.address,40);
    await move(f,f.bob,'redeem',40n);
    await move(f,f.alice,'redeem',60n);
    expect(await f.pool.getPoolBalance()).to.equal(77);
    await move(f,f.bob,'deposit',16n);
    await move(f,f.bob,'redeem',16n);
    expect(await f.pool.getPoolBalance()).to.equal(77);
  });

  it('isolated confiscation mock: shortfall and underbacking revert without burning', async () => {
    f = await fixture('SecurePool','AdversarialAsset');
    await move(f,f.alice,'deposit',100n);
    await f.asset.confiscate(f.pool.target,80);
    await unchanged(f,()=>f.pool.connect(f.alice).redeem(100),f.pool,'InsufficientPoolAssets');
    await unchanged(f,()=>f.pool.connect(f.alice).redeem(1),f.pool,'InsufficientBacking');
    await unchanged(f,()=>f.pool.connect(f.bob).deposit(10),f.pool,'InsufficientBacking');
  });

  it('fee-on-transfer and false-return assets are rejected atomically on both directions', async () => {
    f = await fixture('SecurePool','AdversarialAsset');
    await f.asset.setMode(1);
    await unchanged(f,()=>f.pool.connect(f.alice).deposit(100),f.pool,'UnsupportedAssetTransfer');
    await f.asset.setMode(2);
    await unchanged(f,()=>f.pool.connect(f.alice).deposit(100),f.pool,'SafeERC20FailedOperation');
    await f.asset.setMode(0);
    await move(f,f.alice,'deposit',100n);
    await f.asset.setMode(1);
    await unchanged(f,()=>f.pool.connect(f.alice).redeem(100),f.pool,'UnsupportedAssetTransfer');
    await f.asset.setMode(2);
    await unchanged(f,()=>f.pool.connect(f.alice).redeem(100),f.pool,'SafeERC20FailedOperation');
  });

  it('token callback reentry is blocked on deposit and redeem', async () => {
    f = await fixture('SecurePool','AdversarialAsset');
    await f.asset.setMode(3);
    await move(f,f.alice,'deposit',100n);
    expect(await f.asset.reentryError()).to.equal(f.pool.interface.getError('ReentrancyGuardReentrantCall').selector);
    await move(f,f.alice,'redeem',100n);
    expect(await f.asset.reentryError()).to.equal(f.pool.interface.getError('ReentrancyGuardReentrantCall').selector);
  });

  it('uint256 maximum fully funded roundtrip has no artificial amount limit', async () => {
    const [admin] = await ethers.getSigners();
    const asset = await ethers.deployContract('TestToken');
    const pool = await ethers.deployContract('SecurePool');
    const share = await ethers.deployContract('PoolShareToken',[pool.target]);
    await pool.initialize(asset.target,share.target);
    await asset.mint(admin.address,ethers.MaxUint256);
    await asset.approve(pool.target,ethers.MaxUint256);
    await expect(pool.deposit(ethers.MaxUint256)).to.emit(pool,'Deposited').withArgs(admin.address,ethers.MaxUint256,ethers.MaxUint256);
    expect(await share.totalSupply()).to.equal(ethers.MaxUint256);
    expect(await pool.getPoolBalance()).to.equal(ethers.MaxUint256);
    expect(await asset.balanceOf(admin.address)).to.equal(0);
    await expect(pool.redeem(ethers.MaxUint256)).to.emit(pool,'Redeemed').withArgs(admin.address,ethers.MaxUint256,ethers.MaxUint256);
    expect(await asset.balanceOf(admin.address)).to.equal(ethers.MaxUint256);
    expect(await share.totalSupply()).to.equal(0);
    expect(await share.balanceOf(admin.address)).to.equal(0);
    expect(await pool.getPoolBalance()).to.equal(0);
  });
});
