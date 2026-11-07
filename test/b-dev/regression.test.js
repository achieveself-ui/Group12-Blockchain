const { expect } = require('chai');
const { fixture, state, move, unchanged } = require('./helpers');

describe('B development: deterministic regression seed 0x5eed', function () {
  this.timeout(240000);
  it('1000 mixed operations preserve backing, supply and exact deltas', async () => {
    const f = await fixture();
    let seed = 0x5eedn;
    const next = () => { seed = (seed * 1664525n + 1013904223n) & 0xffffffffn; return seed; };
    for (let i=0;i<1000;i++) {
      const user = next()%2n ? f.alice:f.bob;
      const op = Number(next()%5n);
      const amount = next()%100n+1n;
      if (op === 0) {
        if (await f.pool.paused()) await f.pool.unpause(); else await f.pool.pause();
      } else if (op === 1) {
        await f.asset.connect(user).transfer(f.pool.target,amount);
      } else if (await f.pool.paused()) {
        await unchanged(f,()=>f.pool.connect(user).deposit(amount),f.pool,'EnforcedPause');
      } else if (op === 2) {
        const bal = await f.share.balanceOf(user.address);
        if (bal > 0n) await move(f,user,'redeem',bal < amount ? bal:amount);
      } else await move(f,user,'deposit',amount);
      const s = await state(f);
      expect(s.assets).to.be.gte(s.supply);
      expect(s.poolBalance).to.equal(s.assets);
      expect(s.shares.reduce((a,b)=>a+b,0n)).to.equal(s.supply);
    }
  });

  it('1000 seeded immediate roundtrips restore every tracked balance exactly', async () => {
    const f = await fixture();
    await move(f,f.bob,'deposit',1000n);
    let seed = 0x5eedn;
    for (let i=0;i<1000;i++) {
      seed = (seed * 1664525n + 1013904223n) & 0xffffffffn;
      const amount = seed%1000000n+1n;
      const before = await state(f);
      await move(f,f.alice,'deposit',amount);
      await move(f,f.alice,'redeem',amount);
      expect(await state(f)).to.deep.equal(before);
    }
  });
});
