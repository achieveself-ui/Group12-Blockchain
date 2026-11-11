// ============================================================================
// test/security-regression.test.js  ——  REG-01 ~ REG-04 回归闸门
// ----------------------------------------------------------------------------
// 【本文件的性质：回归闸门】
//   本文件是 B 每次修改合约后的**合并闸门**：任何一条失败都必须阻断合并，
//   并把最小复现命令（见文末"失败时怎么办"）写进 docs/issue-log.md 再反馈给 B。
//   不允许"先合并再修"，也不允许为让闸门变绿而改动本文件的断言方向。
//
// 【本文件的四类职责】
//   REG-01 攻击前后对比：同一组固定输入，分别喂给 VulnerablePool / SecurePool，
//          并排输出对照表。最重要的一条断言是"正常存款两版结果一致"——
//          它证明修复没有顺手把正常业务改坏。
//   REG-02 不变量：固定种子伪随机生成 ≥10 组存赎序列，每一步校验 INV1~INV5。
//   REG-03 极端边界：1 wei 存款 / 接近全额存款 / uint256.max 赎回。
//   REG-04 冒烟回归：5 条最快用例，`npx hardhat test --grep "冒烟"` 单独跑。
//
// 【为什么随机数用固定种子】
//   回归测试的第一要务是"可重复"。如果用 Math.random()，一旦某条序列触发了
//   缺陷，我们无法再次跑出同一条序列，issue-log 里的"最小复现"就写不出来。
//   固定种子 LCG：同一仓库、同一种子 ⇒ 永远生成同一批序列。想换一批新序列，
//   改 SEED 常量并把旧种子的结果归档进 artifacts/，而不是删掉。
//
// 【与 Q 清单的挂接点（未定稿前不收紧）】
//   Q12 死份额：INV1 目前按"无 dead shares"实现（address(0) 不计入）。
//   Q17 缺陷落点：REG-01 漏洞版的"异常铸币倍数"用常量 MINT_MULTIPLE 调节。
//   Q2~Q4 错误名：所有回滚断言暂用 .to.be.reverted，TODO(api-spec.md) 标出。
//
// 【失败时怎么办】
//   1) 不要改断言让灯变绿；
//   2) 复制失败用例名，运行：
//        npx hardhat test test/security-regression.test.js --grep "<用例名>"
//      把命令 + 完整输出贴进 docs/issue-log.md（含 commit hash 与 seed）；
//   3) 通知 B，走"定向测试 → 全量回归 → 关闭"流程。
//
// 【运行范围】仅 Hardhat 本地网络（本文件部署 VulnerablePool）。
// ============================================================================

const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// ----------------------------------------------------------------------------
// 可调常量（合约/规范定稿后只改这里）
// ----------------------------------------------------------------------------

// TODO(Q19): 与 B 的构造函数签名对齐
const SHARE_TOKEN_ARGS = []; // 候选: ["Pool Share","PS",池地址] / ["Pool Share","PS"] / []
const TEST_TOKEN_ARGS = [];  // 候选: ["Test Token","TT"] / []

const INITIAL_FUNDS = ethers.parseEther("10000"); // 每账户初始测试资产
const NORMAL_DEPOSIT = 5000n;                     // 攻击序列第 1 步：正常存款
const MICRO_DEPOSIT = 16n;                        // 攻击序列第 3 步：微额存款
// TODO(Q17): 异常铸币的判定倍数，随 B 的《教学缺陷说明》定稿收紧（100 / 1000）
const MINT_MULTIPLE = 10n;
const REG_SEED = 20261109n;  // 回归序列种子：换种子 = 换一批序列，旧结果先归档
const REG_GROUPS = 10;       // 不变量随机序列组数（≥10，验收下限）
const OPS_PER_GROUP = 12;    // 每组操作步数

// ----------------------------------------------------------------------------
// 部署夹具
// ----------------------------------------------------------------------------

// 单池部署内核：一套独立的资产代币 + 凭证代币 + 池，与其他池彻底隔离。
// 为什么不能共用一份 PoolShareToken：凭证"仅池合约可 mint/burn"通常只认
// 一个池地址；两个池共用一份凭证，必然有一个池连铸币权都没有。
async function deployOnePool(poolContractName) {
  const [owner, alice, bob, attacker] = await ethers.getSigners();

  const TestToken = await ethers.getContractFactory("TestToken");
  const assetToken = await TestToken.deploy(...TEST_TOKEN_ARGS);
  await assetToken.waitForDeployment();

  const PoolShareToken = await ethers.getContractFactory("PoolShareToken");
  const shareToken = await PoolShareToken.deploy(...SHARE_TOKEN_ARGS);
  await shareToken.waitForDeployment();

  const Pool = await ethers.getContractFactory(poolContractName);
  const pool = await Pool.deploy();
  await pool.waitForDeployment();
  await (await pool.initialize(
    await assetToken.getAddress(), await shareToken.getAddress()
  )).wait();

  for (const u of [alice, bob, attacker]) {
    await (await assetToken.mint(u.address, INITIAL_FUNDS)).wait();
    await (await assetToken.connect(u).approve(await pool.getAddress(), INITIAL_FUNDS)).wait();
  }
  return { owner, alice, bob, attacker, assetToken, shareToken, pool };
}

// 双池夹具：REG-01 对比用。两版各一套独立代币与池，仅共享签名者
// （getSigners() 顺序固定，两次部署拿到的是同一批账户）。
async function deployFixture() {
  const v = await deployOnePool("VulnerablePool");
  const s = await deployOnePool("SecurePool");
  return {
    owner: v.owner, alice: v.alice, bob: v.bob, attacker: v.attacker,
    vulnerable: { pool: v.pool, shareToken: v.shareToken, assetToken: v.assetToken },
    secure: { pool: s.pool, shareToken: s.shareToken, assetToken: s.assetToken },
  };
}

// 单池夹具：不变量/边界/冒烟只需要修复版
async function deploySecureOnly() {
  const r = await deployOnePool("SecurePool");
  return { ...r, secure: r.pool };
}

// ----------------------------------------------------------------------------
// 状态工具（与 deposit-redeem / secure-pool 同款，内联不共享）
// ----------------------------------------------------------------------------

async function snapshotState(users, pool, shareToken, assetToken) {
  const poolAddr = await pool.getAddress();
  const snap = {
    totalSupply: await shareToken.totalSupply(),
    poolBalance: await pool.getPoolBalance(),
    poolRealBalance: await assetToken.balanceOf(poolAddr),
    initialized: await pool.initialized(),
    paused: await pool.paused(),
    users: [],
  };
  for (const u of users) {
    snap.users.push({
      address: u.address,
      assets: await assetToken.balanceOf(u.address),
      shares: await shareToken.balanceOf(u.address),
    });
  }
  return snap;
}

function expectPoolState(snap, context) {
  expect(snap.poolBalance, `${context}: getPoolBalance() != 池真实余额`).to.equal(snap.poolRealBalance);
  expect(snap.totalSupply, `${context}: totalSupply != getPoolBalance()`).to.equal(snap.poolBalance);
}

// 回滚后状态零改动的完整比较（含 initialized / paused，比只比余额更严格）
function expectSnapshotsEqual(before, after, context) {
  expect(after.totalSupply, `${context}: totalSupply 被改动`).to.equal(before.totalSupply);
  expect(after.poolBalance, `${context}: getPoolBalance() 被改动`).to.equal(before.poolBalance);
  expect(after.poolRealBalance, `${context}: 池真实余额被改动`).to.equal(before.poolRealBalance);
  expect(after.initialized, `${context}: initialized 被改动`).to.equal(before.initialized);
  expect(after.paused, `${context}: paused 被改动`).to.equal(before.paused);
  expect(after.users.length).to.equal(before.users.length);
  for (let i = 0; i < before.users.length; i++) {
    expect(after.users[i].assets, `${context}: 用户${i}资产被改动`).to.equal(before.users[i].assets);
    expect(after.users[i].shares, `${context}: 用户${i}凭证被改动`).to.equal(before.users[i].shares);
  }
}

function fmt(n) { return n.toString(); }

// ----------------------------------------------------------------------------
// 固定种子伪随机（LCG，Numerical Recipes 参数）
// 为什么不用 Math.random()：见文件头"为什么随机数用固定种子"。
// ----------------------------------------------------------------------------
function makeRng(seed) {
  let s = seed % 2147483647n;
  if (s <= 0n) s += 2147483646n;
  return function next(mod) {
    s = (s * 16807n) % 2147483647n;
    return s % BigInt(mod);
  };
}

// ----------------------------------------------------------------------------
// 攻击序列：同一组固定输入喂给任一池，返回每一步的观测记录
// ----------------------------------------------------------------------------
// 序列（固定 5 步）：
//   S1 正常存款  S2 清空池子  S3 微额存款  S4 重复 initialize  S5 超额赎回
// 每一步用 try/catch 记录"成功/回滚"，绝不让单步异常中断后续观测——
// 我们要的是完整的行为画像，而不是第一个红。
async function runAttackSequence(pool, shareToken, assetToken, alice, attacker) {
  const poolAddr = await pool.getAddress();
  const rec = {};

  // S1 正常存款
  {
    const sharesBefore = await shareToken.balanceOf(alice.address);
    try {
      await (await pool.connect(alice).deposit(NORMAL_DEPOSIT)).wait();
      const minted = (await shareToken.balanceOf(alice.address)) - sharesBefore;
      rec.s1 = { ok: true, minted, note: `成功，铸 ${fmt(minted)}` };
    } catch {
      rec.s1 = { ok: false, minted: 0n, note: "回滚" };
    }
  }

  // S2 清空池子（alice 全额赎回）
  {
    const aliceShares = await shareToken.balanceOf(alice.address);
    try {
      await (await pool.connect(alice).redeem(aliceShares)).wait();
      rec.s2 = { ok: true, note: "成功" };
    } catch {
      rec.s2 = { ok: false, note: "回滚" };
    }
    rec.s2.poolReal = await assetToken.balanceOf(poolAddr);
    rec.s2.poolView = await pool.getPoolBalance();
  }

  // S3 微额存款（攻击者存 16 最小单位）
  {
    const sharesBefore = await shareToken.balanceOf(attacker.address);
    try {
      await (await pool.connect(attacker).deposit(MICRO_DEPOSIT)).wait();
      rec.s3 = { ok: true, minted: (await shareToken.balanceOf(attacker.address)) - sharesBefore };
      rec.s3.note = `成功，铸 ${fmt(rec.s3.minted)}`;
    } catch {
      rec.s3 = { ok: false, minted: 0n, note: "回滚" };
    }
  }

  // S4 重复 initialize（相同参数；Q8 口径：任意参数的第二次都必须回滚）
  {
    const shareBefore = await pool.shareToken();
    try {
      await (await pool.initialize(await assetToken.getAddress(), await shareToken.getAddress())).wait();
      rec.s4 = { ok: true, shareChanged: (await pool.shareToken()) !== shareBefore, note: "成功" };
    } catch {
      rec.s4 = { ok: false, shareChanged: false, note: "回滚" };
    }
  }

  // S5 超额赎回
  //   漏洞版：赎回攻击者全部（异常）凭证，观察是否取回 > 投入；
  //   修复版：攻击者至多持有 16 凭证，改申请 MaxUint256，必须回滚。
  {
    const attackerShares = await shareToken.balanceOf(attacker.address);
    const assetsBefore = await assetToken.balanceOf(attacker.address);
    const attempt = attackerShares > MICRO_DEPOSIT * MINT_MULTIPLE
      ? attackerShares               // 漏洞版路径：全赎异常凭证
      : ethers.MaxUint256;           // 修复版路径：明显超额
    try {
      await (await pool.connect(attacker).redeem(attempt)).wait();
      const gained = (await assetToken.balanceOf(attacker.address)) - assetsBefore;
      rec.s5 = { ok: true, gained, note: `成功，取回 ${fmt(gained)}` };
    } catch {
      rec.s5 = { ok: false, gained: 0n, note: "回滚" };
    }
  }

  rec.final = {
    totalSupply: await shareToken.totalSupply(),
    poolView: await pool.getPoolBalance(),
    poolReal: await assetToken.balanceOf(poolAddr),
  };
  return rec;
}

// ============================================================================
// 环境守卫：本文件部署 VulnerablePool，严禁在公共网络执行
// ============================================================================
before(async function () {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 31337n) {
    throw new Error(
      `[安全红线] security-regression.test.js 含 VulnerablePool，只能在 Hardhat 本地链运行，` +
      `当前 chainId=${chainId}（网络 ${network.name}）。请使用默认命令：npx hardhat test`
    );
  }
});

// ============================================================================
// REG-01 攻击前后对比
// ============================================================================
describe("REG-01 攻击前后对比", function () {
  let ctx;
  beforeEach(async function () { ctx = await deployFixture(); });

  it("同一组输入：正常存款两版一致，漏洞版复现缺陷，修复版拒绝或 1:1", async function () {
    const { alice, attacker, vulnerable: V, secure: S } = ctx;

    // 同一组输入，两版各跑一套独立部署（代币、池互不共享，见 deployFixture 注释）
    const v = await runAttackSequence(V.pool, V.shareToken, V.assetToken, alice, attacker);
    const s = await runAttackSequence(S.pool, S.shareToken, S.assetToken, alice, attacker);

    // —— 对照表（列固定：步骤｜漏洞版结果｜修复版结果｜关键数值）——
    const rows = [
      { 步骤: "S1 正常存款 5000", 漏洞版结果: v.s1.note, 修复版结果: s.s1.note,
        关键数值: `漏洞铸 ${fmt(v.s1.minted)} / 修复铸 ${fmt(s.s1.minted)}` },
      { 步骤: "S2 清空池子", 漏洞版结果: v.s2.note, 修复版结果: s.s2.note,
        关键数值: `池真实 漏洞 ${fmt(v.s2.poolReal)} / 修复 ${fmt(s.s2.poolReal)}` },
      { 步骤: "S3 微额存款 16", 漏洞版结果: v.s3.note, 修复版结果: s.s3.note,
        关键数值: `漏洞铸 ${fmt(v.s3.minted)} / 修复铸 ${fmt(s.s3.minted)}` },
      { 步骤: "S4 重复 initialize", 漏洞版结果: v.s4.note, 修复版结果: s.s4.note,
        关键数值: `shareToken被改写 漏洞 ${v.s4.shareChanged} / 修复 ${s.s4.shareChanged}` },
      { 步骤: "S5 超额赎回", 漏洞版结果: v.s5.note, 修复版结果: s.s5.note,
        关键数值: `攻击者取回 漏洞 ${fmt(v.s5.gained)} / 修复 ${fmt(s.s5.gained)}` },
      { 步骤: "终态 三方一致性",
        漏洞版结果: `账 ${fmt(v.final.poolView)} / 实 ${fmt(v.final.poolReal)} / 供 ${fmt(v.final.totalSupply)}`,
        修复版结果: `账 ${fmt(s.final.poolView)} / 实 ${fmt(s.final.poolReal)} / 供 ${fmt(s.final.totalSupply)}`,
        关键数值: "1:1 下三者应恒等" },
    ];
    console.log("\n===== 攻击前后对照表（同一组输入） =====");
    console.table(rows);

    // —— 断言 1（最重要）：正常存款两版结果必须一致 ——
    // 为什么最重要：修复的全部意义是"挡住异常"。如果修复顺手把正常业务改坏了，
    // 那"漏洞版被拦住"毫无意义——任何合约都能靠禁止一切来防攻击。
    // 所以这一条必须先绿，再看异常路径的分叉。
    expect(v.s1.ok, "漏洞版正常存款失败：基线不可用，后续对比失去意义").to.be.true;
    expect(s.s1.ok, "修复版正常存款失败：修复破坏了正常业务").to.be.true;
    expect(s.s1.minted, "修复版正常存款铸币量 != 漏洞版：修复改变了正常路径的 1:1 语义")
      .to.equal(v.s1.minted);
    expect(s.s1.minted, "正常存款不再是 1:1").to.equal(NORMAL_DEPOSIT);

    // —— 断言 2：漏洞版必须复现缺陷（三类断言全保留，TODO(Q17) 可调倍数）——
    expect(v.s3.ok, "漏洞版微额存款未成功：缺陷未被触发，检查攻击序列是否与实现对齐").to.be.true;
    expect(v.s3.minted,
      `漏洞版未出现数量级异常铸币（铸 ${fmt(v.s3.minted)}，阈值 ${fmt(MICRO_DEPOSIT * MINT_MULTIPLE)}）：` +
      "若 B 的缺陷落点不在此处，调整攻击序列步骤，但不得删除本断言"
    ).to.be.gt(MICRO_DEPOSIT * MINT_MULTIPLE);
    expect(v.s4.ok, "漏洞版重复 initialize 被回滚：与设计意图不符，请与 B 核对实现").to.be.true;
    // 状态失同步：清空后账面与真实余额分叉，或终态三方不一致
    const desync = v.s2.poolView !== v.s2.poolReal ||
      v.final.poolView !== v.final.poolReal || v.final.totalSupply !== v.final.poolReal;
    expect(desync, "漏洞版未观测到状态失同步：三类缺陷至少应复现一类，请与 B 核对实现").to.be.true;

    // —— 断言 3：修复版对同一组输入，要么回滚，要么严格 1:1 ——
    if (s.s3.ok) {
      expect(s.s3.minted, "修复版微额存款出现超额铸币：异常铸币防护失效").to.equal(MICRO_DEPOSIT);
    } // 回滚同样合格（对应 SEC-12 的"拒绝或 1:1"二选一）
    expect(s.s4.ok, "修复版重复 initialize 竟然成功：一次性初始化防护失效").to.be.false;
    expect(s.s4.shareChanged, "修复版 shareToken 被改写").to.be.false;
    expect(s.s5.ok, "修复版接受了 uint256.max 级赎回：余额/上限校验缺失").to.be.false;
    expect(s.s5.gained, "修复版中攻击者凭空获得资产").to.equal(0n);
    // 修复版终态三方恒等
    expect(s.final.poolView, "修复版终态：getPoolBalance != 池真实余额").to.equal(s.final.poolReal);
    expect(s.final.totalSupply, "修复版终态：totalSupply != 池真实余额").to.equal(s.final.poolReal);
  });
});

// ============================================================================
// REG-02 不变量
// ============================================================================
describe("REG-02 不变量", function () {
  // TODO(Q12): 若最终采用 dead shares，INV1 的求和范围要加入 address(0)

  it(`固定种子 ${REG_SEED}：${REG_GROUPS} 组随机存赎序列，每步校验 INV1~INV5`, async function () {
    this.timeout(300000); // 10 组 × 12 步 × 独立部署，给足余量

    for (let g = 0; g < REG_GROUPS; g++) {
      const ctx = await deploySecureOnly();
      const { owner, alice, bob, attacker, assetToken, shareToken, secure } = ctx;
      const users = [alice, bob, attacker];
      const rng = makeRng(REG_SEED + BigInt(g));

      // 链下账本：1:1 无舍入规则下，每个账户的资产/凭证可精确推演。
      // 为什么需要它：INV3"拿回 ≤ 存入"如果只看链上瞬时值，无法区分
      // "合法赎回到账"与"凭空多出"；必须全程累计对照。
      const ledger = users.map(() => ({ deposited: 0n, redeemed: 0n, shares: 0n }));
      const everInitialized = await secure.initialized();

      for (let step = 0; step < OPS_PER_GROUP; step++) {
        const ui = Number(rng(3n));
        const user = users[ui];
        const book = ledger[ui];
        const opKind = Number(rng(10n)); // 0-3 存 / 4-7 赎 / 8-9 非法操作
        const label = `组${g}-步${step}`;

        const before = await snapshotState(users, secure, shareToken, assetToken);
        // INV4：initialized 只能 false -> true 单向（夹具内已为 true，之后不得变回 false）
        expect(before.initialized, `${label}: INV4 被破坏，initialized 从 true 回到 false`)
          .to.equal(everInitialized);

        if (opKind <= 3) {
          // 合法存款：1 wei ~ 500×10^6 之间的随机额（覆盖 wei 级与常规级）
          const amount = (rng(500n) + 1n) * 10n ** rng(7n);
          await (await secure.connect(user).deposit(amount)).wait();
          book.deposited += amount; book.shares += amount;
        } else if (opKind <= 7) {
          if (book.shares === 0n) {
            // 没凭证可赎时改做一笔小额存款，避免整步退化成空操作
            const amount = rng(100n) + 1n;
            await (await secure.connect(user).deposit(amount)).wait();
            book.deposited += amount; book.shares += amount;
          } else {
            // 赎回自身凭证的 1/(k+1)，至少 1，永不超过持仓
            let part = book.shares / (rng(3n) + 1n);
            if (part === 0n) part = 1n;
            if (part > book.shares) part = book.shares;
            await (await secure.connect(user).redeem(part)).wait();
            book.shares -= part; book.redeemed += part;
          }
        } else {
          // —— INV5 探针：故意制造失败交易，验证状态分毫未动 ——
          const badKind = Number(rng(3n));
          let p;
          if (badKind === 0) p = secure.connect(user).deposit(0);
          else if (badKind === 1) p = secure.connect(user).redeem(0);
          else p = secure.connect(user).redeem(book.shares + 1000n); // 超额赎回
          // TODO(api-spec.md): Q2/Q3 定稿后收紧为 revertedWithCustomError
          await expect(p, `${label}: INV5 探针预期回滚但成功了`).to.be.reverted;
          const after = await snapshotState(users, secure, shareToken, assetToken);
          expectSnapshotsEqual(before, after, `${label}: INV5`);
          continue; // 失败交易不改账本，直接进入下一步
        }

        const after = await snapshotState(users, secure, shareToken, assetToken);

        // INV1：totalSupply == Σ 所有相关地址凭证余额（owner/alice/bob/attacker/池）
        const sumShares =
          (await shareToken.balanceOf(owner.address)) +
          after.users[0].shares + after.users[1].shares + after.users[2].shares +
          (await shareToken.balanceOf(await secure.getAddress()));
        expect(after.totalSupply, `${label}: INV1 被破坏，totalSupply != Σ凭证余额`).to.equal(sumShares);

        // INV2：getPoolBalance() == 池合约真实资产余额
        expect(after.poolBalance, `${label}: INV2 被破坏，账面 != 真实`).to.equal(after.poolRealBalance);

        // 链下账本与链上逐项相等（1:1 规则的最强形式化）
        expect(after.users[ui].shares, `${label}: 链上凭证 != 链下账本`).to.equal(book.shares);
        const expectedAssets = INITIAL_FUNDS - book.deposited + book.redeemed;
        expect(after.users[ui].assets, `${label}: 链上资产 != 链下账本`).to.equal(expectedAssets);
      }

      // INV3（组末）：每个用户累计拿回 ≤ 累计存入——不允许凭空多出资产
      for (let i = 0; i < users.length; i++) {
        expect(ledger[i].redeemed,
          `组${g}: INV3 被破坏，用户${i}拿回 ${fmt(ledger[i].redeemed)} > 存入 ${fmt(ledger[i].deposited)}`
        ).to.be.lte(ledger[i].deposited);
      }
      console.log(`  [REG-02] 组 ${g}: ${OPS_PER_GROUP} 步完成，INV1~INV5 全过`);
    }
  });
});

// ============================================================================
// REG-03 极端边界
// ============================================================================
describe("REG-03 极端边界", function () {
  let ctx;
  beforeEach(async function () { ctx = await deploySecureOnly(); });

  it("REG-03a deposit(1)：1 wei 级存款要么严格 1:1，要么回滚且状态不变", async function () {
    const { alice, assetToken, shareToken, secure } = ctx;
    const users = [alice];
    const before = await snapshotState(users, secure, shareToken, assetToken);

    // 与 SEC-12 同一原则：不写死实现必须接受，写死"接受就必须精确"
    try {
      await (await secure.connect(alice).deposit(1n)).wait();
      const after = await snapshotState(users, secure, shareToken, assetToken);
      expect(after.users[0].shares - before.users[0].shares,
        "deposit(1) 铸出的凭证 != 1：wei 级输入触发异常铸币").to.equal(1n);
      expect(after.poolBalance, "deposit(1) 后账面 != 池真实余额").to.equal(after.poolRealBalance);
      expect(after.totalSupply - before.totalSupply, "deposit(1) 后 totalSupply 增量 != 1").to.equal(1n);
      console.log("  [REG-03a] deposit(1) 被接受，严格 1:1 成立");
    } catch {
      const after = await snapshotState(users, secure, shareToken, assetToken);
      expectSnapshotsEqual(before, after, "REG-03a deposit(1) 回滚后");
      console.log("  [REG-03a] deposit(1) 被拒绝，状态分毫未动");
    }
  });

  it("REG-03b 接近全部余额的存款：精确 1:1，且能分毫不差地拿回", async function () {
    const { alice, assetToken, shareToken, secure } = ctx;
    // 留 1 wei 观察"边界擦边"是否引发换算异常
    const amount = INITIAL_FUNDS - 1n;
    const sharesBefore = await shareToken.balanceOf(alice.address);

    await (await secure.connect(alice).deposit(amount)).wait();

    const minted = (await shareToken.balanceOf(alice.address)) - sharesBefore;
    expect(minted, "接近全额存款出现超额铸币").to.equal(amount);
    expect(await assetToken.balanceOf(alice.address), "存款后剩余资产 != 1 wei").to.equal(1n);
    const snap = await snapshotState([alice], secure, shareToken, assetToken);
    expectPoolState(snap, "REG-03b");

    // 随后全额赎回，应分毫不差地复原
    await (await secure.connect(alice).redeem(amount)).wait();
    expect(await assetToken.balanceOf(alice.address),
      "全额赎回后资产未精确复原：存在舍入或暗扣").to.equal(INITIAL_FUNDS);
    console.log(`  [REG-03b] 存 ${fmt(amount)} → 铸 ${fmt(minted)} → 全赎后复原 ${fmt(INITIAL_FUNDS)}`);
  });

  it("REG-03c redeem(type(uint256).max)：必须回滚且状态不变", async function () {
    const { alice, assetToken, shareToken, secure } = ctx;
    const users = [alice];
    await (await secure.connect(alice).deposit(1000n)).wait(); // 先制造合法持仓
    const before = await snapshotState(users, secure, shareToken, assetToken);

    // TODO(api-spec.md): Q3 → 候选 revertedWithCustomError(shareToken, "ERC20InsufficientBalance")
    await expect(secure.connect(alice).redeem(ethers.MaxUint256),
      "期望回滚但交易成功：uint256.max 级赎回被接受，疑似缺失余额校验或存在溢出路径"
    ).to.be.reverted;

    const after = await snapshotState(users, secure, shareToken, assetToken);
    expectSnapshotsEqual(before, after, "REG-03c");
    // 合法持仓仍可全额赎回，证明上面的拒绝针对"超额"而非误伤
    await (await secure.connect(alice).redeem(1000n)).wait();
    expect(await shareToken.balanceOf(alice.address), "合法持仓赎回后凭证未归零").to.equal(0n);
    console.log("  [REG-03c] max 赎回被拒，合法 1000 凭证全额赎回正常");
  });
});

// ============================================================================
// REG-04 冒烟回归（用例名必须含"冒烟"，支持 --grep "冒烟" 单独运行）
// ============================================================================
describe("REG-04 冒烟回归", function () {
  let ctx;
  beforeEach(async function () { ctx = await deploySecureOnly(); });

  it("冒烟01 正常存款 1:1 且三方一致", async function () {
    const { alice, assetToken, shareToken, secure } = ctx;
    await (await secure.connect(alice).deposit(100n)).wait();
    expect(await shareToken.balanceOf(alice.address), "冒烟01: 凭证 != 100").to.equal(100n);
    expect(await secure.getPoolBalance(), "冒烟01: 账面 != 100").to.equal(100n);
    expect(await assetToken.balanceOf(await secure.getAddress()), "冒烟01: 池实 != 100").to.equal(100n);
    expect(await shareToken.totalSupply(), "冒烟01: 供应 != 100").to.equal(100n);
  });

  it("冒烟02 正常赎回分毫不差", async function () {
    const { alice, assetToken, shareToken, secure } = ctx;
    await (await secure.connect(alice).deposit(200n)).wait();
    await (await secure.connect(alice).redeem(200n)).wait();
    expect(await shareToken.balanceOf(alice.address), "冒烟02: 凭证未归零").to.equal(0n);
    expect(await assetToken.balanceOf(alice.address), "冒烟02: 资产未复原").to.equal(INITIAL_FUNDS);
    expect(await secure.getPoolBalance(), "冒烟02: 池未归零").to.equal(0n);
  });

  it("冒烟03 deposit(0) 被拒绝且状态不变", async function () {
    const { alice, secure } = ctx;
    // TODO(api-spec.md): Q2 → 收紧 revertedWithCustomError(secure, "ZeroAmount")
    await expect(secure.connect(alice).deposit(0),
      "冒烟03: deposit(0) 未被拒绝").to.be.reverted;
    expect(await secure.getPoolBalance(), "冒烟03: 拒绝后池余额被改动").to.equal(0n);
  });

  it("冒烟04 暂停后存款被拒绝、查询仍可用", async function () {
    const { owner, alice, secure } = ctx;
    await (await secure.connect(owner).pause()).wait();
    expect(await secure.paused(), "冒烟04: paused() 未置真").to.be.true;
    // TODO(api-spec.md): Q4 → 收紧 revertedWithCustomError(secure, "EnforcedPause")
    await expect(secure.connect(alice).deposit(100n),
      "冒烟04: 暂停期存款未被拒绝").to.be.reverted;
    // 查询不受影响
    expect(await secure.getPoolBalance()).to.equal(0n);
    expect(await secure.initialized()).to.be.true;
    await (await secure.connect(owner).unpause()).wait();
    expect(await secure.paused(), "冒烟04: unpause 未生效").to.be.false;
  });

  it("冒烟05 二次 initialize 被拒绝", async function () {
    const { assetToken, shareToken, secure } = ctx;
    expect(await secure.initialized(), "冒烟05: 夹具内应为已初始化").to.be.true;
    // TODO(api-spec.md): Q8 → 收紧 revertedWithCustomError(secure, "AlreadyInitialized")
    await expect(secure.initialize(await assetToken.getAddress(), await shareToken.getAddress()),
      "冒烟05: 二次 initialize 未被拒绝").to.be.reverted;
    expect(await secure.shareToken(), "冒烟05: shareToken 被改写")
      .to.equal(await shareToken.getAddress());
  });
});
