// ============================================================================
// test/deposit-redeem.test.js
// ----------------------------------------------------------------------------
// 【这个文件负责什么】
//   SecurePool（修复版）的「正常业务路径」：存款、赎回、多用户交叉、事件、账目一致性。
//   不做异常拒绝（见 secure-pool.test.js）、不做漏洞演示（见 vulnerable-demo.test.js）。
//   对应 test-plan.md 的 A 组：DR-01 ~ DR-07。
//
// 【断言为什么必须是严格相等】
//   项目采用固定 1:1 规则：存 100 最小单位 → 铸 100 最小单位凭证，全程没有舍入、
//   没有手续费、没有比例换算。既然数学上应当完全相等，用 closeTo / 容差就等于
//   主动放行"每次多 1 个最小单位"这类异常铸币——而这正是本项目要防的核心风险。
//   所以本文件所有金额断言一律 equal，任何偏差（哪怕 1 wei）都判缺陷。
//
// 【每个用例的固定结构】
//   ① snapshotState 记录操作前六大必查数据（①资产余额 ②凭证余额 ③totalSupply
//      ④getPoolBalance() ⑤池真实代币余额；⑥事件单独断言）
//   ② 执行交易
//   ③ 断言操作后状态
//   ④ 打印一行的前后对照（Δ 直接可读），便于 grep 与贴进 artifacts 日志
//
// 【框架】Hardhat + ethers v6 + chai matchers（@nomicfoundation/hardhat-chai-matchers）
// 【当前状态】B 的合约未落地前运行会报 "Artifact not found"，属预期，不代表测试写错。
// ============================================================================

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------------------------------------------------------------------------
// 1. 部署参数：B 定稿后「只改这一块」
// ---------------------------------------------------------------------------
const DECIMALS = 18;
const INITIAL_MINT = ethers.parseUnits("10000", DECIMALS); // 每个测试账户 10000e18

// TODO(api-spec.md): 两个代币的构造参数待 B 定稿（Q19）。三种常见形态：
//   ① 无参 → [] ；② (name, symbol) → ["..",".."] ；③ (name, symbol, owner) → [...]
const TEST_TOKEN_ARGS = [];
const SHARE_TOKEN_ARGS = [];

const POOL_NAME = "SecurePool";

// ---------------------------------------------------------------------------
// 2. 夹具：部署 → 初始化 → 发资产 → approve
//    内联在本文件内（不新增 helpers/ 目录），每个 beforeEach 重建环境，
//    绝不依赖上一个 it 的残留状态。
// ---------------------------------------------------------------------------
async function deployFixture() {
  const [owner, alice, bob, attacker] = await ethers.getSigners();

  // ① 测试资产代币（ERC-20，owner 可 mint）
  const assetToken = await ethers.deployContract("TestToken", TEST_TOKEN_ARGS);
  await assetToken.waitForDeployment();

  // ② 凭证代币（独立 ERC-20，仅池合约可 mint/burn）
  const shareToken = await ethers.deployContract("PoolShareToken", SHARE_TOKEN_ARGS);
  await shareToken.waitForDeployment();

  // ③ 资金池
  const pool = await ethers.deployContract(POOL_NAME);
  await pool.waitForDeployment();

  // ④ 一次性初始化 initialize(assetToken, shareToken)，必须在任何 deposit 之前
  await pool.initialize(await assetToken.getAddress(), await shareToken.getAddress());

  // ⑤ 3 个测试账户各发 10000e18 资产，并授权池子拉款
  for (const user of [alice, bob, attacker]) {
    await assetToken.connect(owner).mint(user.address, INITIAL_MINT);
    await assetToken.connect(user).approve(await pool.getAddress(), ethers.MaxUint256);
  }

  return { owner, alice, bob, attacker, assetToken, shareToken, pool };
}

// ---------------------------------------------------------------------------
// 3. 内联断言 / 打印工具
// ---------------------------------------------------------------------------

/** 打包操作前的账目快照（①~⑤），用于前后对比。 */
async function snapshotState(pool, assetToken, shareToken, users) {
  const poolAddress = await pool.getAddress();

  const userStates = [];
  for (const user of users) {
    userStates.push({
      label: user.address.slice(0, 8),
      address: user.address,
      assets: await assetToken.balanceOf(user.address), // ①
      shares: await shareToken.balanceOf(user.address), // ②
    });
  }

  return {
    pool,
    assetToken,
    shareToken,
    users: userStates,
    totalSupply: await shareToken.totalSupply(), // ③
    poolBalance: await pool.getPoolBalance(), // ④
    poolRealAssets: await assetToken.balanceOf(poolAddress), // ⑤
  };
}

/** 把快照打成表格（人看方便，用于用例开头交代前置状态）。 */
function printStateTable(label, snap) {
  const rows = snap.users.map((u) => ({
    账户: u.label,
    资产余额: u.assets.toString(),
    凭证余额: u.shares.toString(),
  }));
  rows.push({ 账户: "— 池合约 —", 资产余额: snap.poolRealAssets.toString(), 凭证余额: "—" });
  rows.push({ 账户: "— 合计 —", 资产余额: "—", 凭证余额: snap.totalSupply.toString() });

  console.log(`\n===== ${label} =====`);
  console.table(rows);
  console.log(
    `④ getPoolBalance()=${snap.poolBalance}  ⑤ 池真实余额=${snap.poolRealAssets}  ③ totalSupply=${snap.totalSupply}`
  );
}

/**
 * 把「操作前 → 操作后 → 变化量」压成一行日志。
 * 为什么压成一行：artifacts/*.log 要能 grep、要能直接贴进报告；
 * 表格在纯文本日志里会散成十几行，不好比对也不好截图。
 */
function printBeforeAfterLine(label, before, after, userIndex = 0) {
  const b = before.users[userIndex];
  const a = after.users[userIndex];
  const delta = (x, y) => (y - x >= 0n ? `+${y - x}` : `${y - x}`);

  console.log(
    `[${label}] 前: ①${b.assets} ②${b.shares} ③${before.totalSupply} ④${before.poolBalance} ⑤${before.poolRealAssets}` +
      ` | 后: ①${a.assets} ②${a.shares} ③${after.totalSupply} ④${after.poolBalance} ⑤${after.poolRealAssets}` +
      ` | Δ: ①${delta(b.assets, a.assets)} ②${delta(b.shares, a.shares)}` +
      ` ③${delta(before.totalSupply, after.totalSupply)} ④${delta(before.poolBalance, after.poolBalance)}` +
      ` ⑤${delta(before.poolRealAssets, after.poolRealAssets)}`
  );
}

/**
 * 三方一致性断言：
 *   getPoolBalance() == 池合约实际代币余额 == 凭证 totalSupply
 * 签名固定为 (pool, token, expectedPoolBalance, expectedTotalSupply)，
 * 凭证合约通过固定接口 pool.shareToken() 反查，因此调用方不必再传凭证合约。
 */
async function expectPoolState(pool, token, expectedPoolBalance, expectedTotalSupply) {
  const shareToken = await ethers.getContractAt("PoolShareToken", await pool.shareToken());
  const poolAddress = await pool.getAddress();

  const expectedPool = BigInt(expectedPoolBalance);
  const expectedSupply = BigInt(expectedTotalSupply);

  const actualPoolBalance = await pool.getPoolBalance();
  const actualRealBalance = await token.balanceOf(poolAddress);
  const actualSupply = await shareToken.totalSupply();

  expect(actualPoolBalance, "④ getPoolBalance() 与期望不符").to.equal(expectedPool);
  expect(actualRealBalance, "⑤ 池合约真实代币余额与期望不符（账面与真实资产已分叉）").to.equal(expectedPool);
  expect(actualSupply, "③ 凭证 totalSupply 与期望不符").to.equal(expectedSupply);

  // 1:1 规则下这三者必须完全相等；任意两者不等，就说明存在异常铸币或账外资产
  expect(actualPoolBalance, "④ != ⑤：池子的记账值与真实余额不一致").to.equal(actualRealBalance);
  expect(actualPoolBalance, "④ != ③：池内资产与凭证供应量不一致（1:1 被破坏）").to.equal(actualSupply);
}

/**
 * 断言一组地址在交易前后余额完全没变。
 * 用途一：证明"他人账目未被波及"；用途二：证明"交易回滚后状态零改动"。
 * 参数：users 账户数组，tokens [assetToken, shareToken]，snapshot 交易前的快照。
 * 注意：本函数同时校验 ③④⑤，因此只适用于"池子数值本就不该变"的场景
 *      （例如回滚检查）；多用户交叉时池子数值会合法变化，应只比对用户两项。
 */
async function expectBalancesUnchanged(users, tokens, snapshot) {
  const [assetToken, shareToken] = tokens;

  for (let i = 0; i < users.length; i++) {
    const address = users[i].address || users[i];
    expect(await assetToken.balanceOf(address), `${address} 的资产余额被改动`).to.equal(snapshot.users[i].assets);
    expect(await shareToken.balanceOf(address), `${address} 的凭证余额被改动`).to.equal(snapshot.users[i].shares);
  }

  expect(await shareToken.totalSupply(), "totalSupply 被改动").to.equal(snapshot.totalSupply);
  expect(await snapshot.pool.getPoolBalance(), "getPoolBalance() 被改动").to.equal(snapshot.poolBalance);
  expect(
    await assetToken.balanceOf(await snapshot.pool.getAddress()),
    "池合约真实代币余额被改动"
  ).to.equal(snapshot.poolRealAssets);
}

// ---------------------------------------------------------------------------
// 4. 用例
// ---------------------------------------------------------------------------
describe("正常存款", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // DR-01
  // 为什么这组断言能证明没有异常铸币：
  //   异常铸币只有两种典型形态——① 只增供应量不增真实资产（凭空造凭证）；
  //   ② 只收资产不给凭证（吞用户的钱）。
  //   这里同时把「凭证余额 == assets」「totalSupply == assets」「getPoolBalance() == assets」
  //   「池真实余额 == assets」四个数字全部钉在存入量上，等于让"铸币数、记账增量、
  //   真实转账增量"三条线必须重合；任意一条偏离，都说明某个环节多算或少算了。
  it("DR-01 首次存款：凭证余额、总供应量、池内资产、池真实余额都严格等于存入量", async () => {
    const { alice, assetToken, shareToken, pool } = ctx;
    const assets = 100n;

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("DR-01 存款前", before);

    const tx = await pool.connect(alice).deposit(assets);
    await tx.wait();

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("DR-01 首次存款 100", before, after);

    // ② 用户凭证余额 == assets（不多不少）
    expect(after.users[0].shares, "铸出的凭证数必须严格等于存入资产数").to.equal(assets);
    // ① 用户资产余额减少的量 == assets（没有被多扣）
    expect(before.users[0].assets - after.users[0].assets, "用户被扣走的资产必须严格等于存入量").to.equal(assets);
    // ③④⑤ 三方恒等，且都等于 assets
    await expectPoolState(pool, assetToken, assets, assets);

    // ⑥ 事件（字段顺序详见"事件与状态一致性"分组）
    await expect(tx).to.emit(pool, "Deposited").withArgs(alice.address, assets, assets);
  });

  // DR-02
  // 为什么必须看"每一步的增量"而不是只看总量：
  //   异常铸币常常表现为「首次正确、第二次开始漂移」（累计变量未同步、缓存未刷新）。
  //   若只断言 totalSupply == 350，那么"第一次多铸 50、第二次少铸 50"这种
  //   方向相反的偏差会互相抵消，总量看起来完全正常，缺陷被完美掩盖。
  //   断言每一次的 Δ② == Δ①，才能让任何单次偏差无处可藏。
  it("DR-02 连续两次存款：累计值准确，第二次不产生任何额外凭证", async () => {
    const { alice, assetToken, shareToken, pool } = ctx;
    const first = 100n;
    const second = 250n;

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("DR-02 存款前", before);

    const tx1 = await pool.connect(alice).deposit(first);
    await tx1.wait();
    const mid = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("DR-02 第一次存款 100", before, mid);

    const tx2 = await pool.connect(alice).deposit(second);
    await tx2.wait();
    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("DR-02 第二次存款 250", mid, after);

    // 单次增量必须严格 1:1（这才是"没有额外凭证"的硬证据）
    expect(mid.users[0].shares - before.users[0].shares, "第一次：Δ凭证 != Δ资产").to.equal(first);
    expect(after.users[0].shares - mid.users[0].shares, "第二次：Δ凭证 != Δ资产（出现额外铸币）").to.equal(second);

    // 累计值
    expect(after.users[0].shares, "两次存款后的凭证余额应为两次之和").to.equal(first + second);
    expect(before.users[0].assets - after.users[0].assets, "两次存款后的资产支出应为两次之和").to.equal(
      first + second
    );

    // 三方恒等：1:1 下 totalSupply 必然等于累计存入量
    await expectPoolState(pool, assetToken, first + second, first + second);

    await expect(tx1).to.emit(pool, "Deposited").withArgs(alice.address, first, first);
    await expect(tx2).to.emit(pool, "Deposited").withArgs(alice.address, second, second);
  });
});

describe("正常赎回", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // DR-03
  // 为什么这组断言能证明没有资产流失：
  //   赎回方向的风险与存款相反——最危险的是「销毁的凭证少、转出的资产多」，
  //   攻击者就能用少量凭证换走更多真实资产（yETH 事件的最终变现环节正是这个形态）。
  //   这里把三个方向同时钉住：② 凭证减少 shares、① 资产增加 shares、
  //   ③④⑤ 同步减少 shares。四者一致，说明"销毁—记账—转账"是同一个数量。
  it("DR-03 部分赎回：销毁凭证数、取回资产、池内减少量三者严格相等", async () => {
    const { alice, assetToken, shareToken, pool } = ctx;
    const deposited = 450n;
    const shares = 120n;

    // 先备好池子（存款行为本身已由 DR-01/02 覆盖）
    await (await pool.connect(alice).deposit(deposited)).wait();

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("DR-03 赎回前", before);

    const tx = await pool.connect(alice).redeem(shares);
    await tx.wait();

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("DR-03 赎回 120", before, after);

    // ② 销毁的凭证数 == shares
    expect(before.users[0].shares - after.users[0].shares, "销毁的凭证数必须严格等于请求赎回数").to.equal(shares);
    // ① 取回的资产 == shares（1:1 下）
    expect(after.users[0].assets - before.users[0].assets, "取回的资产必须严格等于赎回的凭证数").to.equal(shares);
    // ③④⑤ 同步减少 shares
    expect(before.totalSupply - after.totalSupply, "totalSupply 未与凭证销毁同步").to.equal(shares);
    expect(before.poolBalance - after.poolBalance, "getPoolBalance() 未与转出资产同步").to.equal(shares);
    expect(before.poolRealAssets - after.poolRealAssets, "池真实余额未与转出资产同步").to.equal(shares);

    await expectPoolState(pool, assetToken, deposited - shares, deposited - shares);

    await expect(tx).to.emit(pool, "Redeemed").withArgs(alice.address, shares, shares);
  });

  // DR-04
  // 为什么全额赎回是最硬的一条：
  //   它一次问清"每一笔操作是否留下残渣"。1:1 规则下，存 450 再赎 450 必须精确回到
  //   10000e18；差 1 个最小单位，就说明存在隐藏的舍入、手续费或账目残留——
  //   而"每次漏一点"的偏差累积起来正是资产流失。用约等于断言会把这条线索彻底抹掉。
  it("DR-04 全额赎回：凭证/池内资产/供应量同时归零，取回总额精确等于存入总额", async () => {
    const { alice, assetToken, shareToken, pool } = ctx;
    const deposited = 450n;

    const initialAssets = await assetToken.balanceOf(alice.address);
    await (await pool.connect(alice).deposit(deposited)).wait();

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("DR-04 全额赎回前", before);

    const tx = await pool.connect(alice).redeem(deposited);
    await tx.wait();

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("DR-04 全额赎回 450", before, after);

    // 三项归零
    expect(after.users[0].shares, "用户凭证必须归零").to.equal(0n);
    expect(after.totalSupply, "totalSupply 必须归零").to.equal(0n);
    expect(after.poolBalance, "getPoolBalance() 必须归零").to.equal(0n);
    expect(after.poolRealAssets, "池合约真实代币余额必须归零").to.equal(0n);

    // 取回总额严格等于存入总额：比的是"回到初始值"，不是"约等于"
    expect(after.users[0].assets, "用户资产必须精确回到存入前的数值，不允许差 1 wei").to.equal(initialAssets);

    await expectPoolState(pool, assetToken, 0n, 0n);

    await expect(tx).to.emit(pool, "Redeemed").withArgs(alice.address, deposited, deposited);
  });
});

describe("多用户", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // DR-05
  // 为什么必须单独验证"B 不受影响"：
  //   单用户测试发现不了"共享状态被单人操作污染"的缺陷。例如把 totalSupply
  //   直接赋值为本次存入量（覆盖而非累加），只有一个用户时数字看起来完全正常，
  //   一有第二个人就崩。做法：在 A 赎回之前给 B 单独拍快照，A 赎回后逐项比对
  //   B 的 ①②，全部不变，才能证明 A 的赎回只动了自己的账。
  it("DR-05 多用户交叉：A 存 300、B 存 200、A 赎 100，B 的账目完全不受影响", async () => {
    const { alice, bob, assetToken, shareToken, pool } = ctx;
    const aDeposit = 300n;
    const bDeposit = 200n;
    const aRedeem = 100n;

    await (await pool.connect(alice).deposit(aDeposit)).wait();
    await (await pool.connect(bob).deposit(bDeposit)).wait();

    // A 赎回前：只给 B 拍快照，作为"之后必须一动不动"的基准
    const beforeBob = await snapshotState(pool, assetToken, shareToken, [bob]);
    const beforeAll = await snapshotState(pool, assetToken, shareToken, [alice, bob]);
    printStateTable("DR-05 A 赎回前", beforeAll);

    const tx = await pool.connect(alice).redeem(aRedeem);
    await tx.wait();

    const after = await snapshotState(pool, assetToken, shareToken, [alice, bob]);
    printBeforeAfterLine("DR-05 A 赎回 100", beforeAll, after, 0);
    console.log(
      `[DR-05] B 的对照: 前 ①${beforeBob.users[0].assets} ②${beforeBob.users[0].shares}` +
        ` | 后 ①${after.users[1].assets} ②${after.users[1].shares}（必须完全一致）`
    );

    // A 的账：② 300 → 200；① 9700 → 9800
    expect(after.users[0].shares, "A 赎回后凭证余额应为 200").to.equal(aDeposit - aRedeem);
    expect(after.users[0].assets, "A 的资产余额应为 初始-300+100").to.equal(INITIAL_MINT - aDeposit + aRedeem);

    // B 的账：逐项与"赎回前"比对，而不是只比一个绝对值（后者会漏掉"侥幸相等"）
    expect(after.users[1].shares, "B 的凭证余额被 A 的操作影响了").to.equal(beforeBob.users[0].shares);
    expect(after.users[1].assets, "B 的资产余额被 A 的操作影响了").to.equal(beforeBob.users[0].assets);
    expect(after.users[1].shares, "B 的凭证余额应仍为 200").to.equal(bDeposit);
    expect(after.users[1].assets, "B 的资产余额应仍为 初始-200").to.equal(INITIAL_MINT - bDeposit);

    // 池子的账：300 + 200 - 100 = 400；用户凭证之和必须等于 totalSupply
    expect(after.users[0].shares + after.users[1].shares, "用户凭证之和应等于 totalSupply").to.equal(
      after.totalSupply
    );
    await expectPoolState(pool, assetToken, aDeposit + bDeposit - aRedeem, aDeposit + bDeposit - aRedeem);

    await expect(tx).to.emit(pool, "Redeemed").withArgs(alice.address, aRedeem, aRedeem);
  });
});

describe("事件与状态一致性", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // DR-06
  // 为什么事件要单独测：
  //   链上数字正确、但事件字段写错（把 shares 填成 assets，或参数顺序写反），
  //   任何余额断言都看不出来——但前端、监控、审计、所有靠事件重建账本的系统都会记错。
  //   这类缺陷只能靠 withArgs 与"解析原始日志再逐字段核对"发现。
  //   特别注意：Deposited 是 (user, assets, shares)，Redeemed 是 (user, shares, assets)，
  //   两者顺序相反；照抄会写出一个"永远成立"的假断言。
  it("DR-06 事件字段精确：Deposited(user,assets,shares) / Redeemed(user,shares,assets)", async () => {
    const { alice, assetToken, shareToken, pool } = ctx;
    const depositAmount = 100n;
    const redeemAmount = 40n;

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);

    // —— 存款事件 ——
    const depositTx = await pool.connect(alice).deposit(depositAmount);
    const depositReceipt = await depositTx.wait();

    await expect(depositTx).to.emit(pool, "Deposited").withArgs(alice.address, depositAmount, depositAmount);

    // 再从原始日志解析一遍，确认字段顺序没有被 ABI 悄悄改变
    const depositLog = depositReceipt.logs
      .map((log) => {
        try {
          return pool.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "Deposited");

    expect(depositLog, "未能从交易日志中解析出 Deposited 事件").to.not.equal(undefined);
    expect(depositLog.args.user, "Deposited 第 1 个字段应为 user").to.equal(alice.address);
    expect(depositLog.args.assets, "Deposited 第 2 个字段应为 assets").to.equal(depositAmount);
    expect(depositLog.args.shares, "Deposited 第 3 个字段应为 shares").to.equal(depositAmount);

    // —— 赎回事件 ——
    const redeemTx = await pool.connect(alice).redeem(redeemAmount);
    const redeemReceipt = await redeemTx.wait();

    // 注意参数顺序：Redeemed 是 (user, shares, assets)
    await expect(redeemTx).to.emit(pool, "Redeemed").withArgs(alice.address, redeemAmount, redeemAmount);

    const redeemLog = redeemReceipt.logs
      .map((log) => {
        try {
          return pool.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "Redeemed");

    expect(redeemLog, "未能从交易日志中解析出 Redeemed 事件").to.not.equal(undefined);
    expect(redeemLog.args.user, "Redeemed 第 1 个字段应为 user").to.equal(alice.address);
    expect(redeemLog.args.shares, "Redeemed 第 2 个字段应为 shares").to.equal(redeemAmount);
    expect(redeemLog.args.assets, "Redeemed 第 3 个字段应为 assets").to.equal(redeemAmount);

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("DR-06 存 100 再赎 40", before, after);
  });

  // DR-07
  // 为什么每一步都要查，而不是最后查一次：
  //   getPoolBalance() == 池真实余额 == totalSupply 是 1:1 规则的核心不变量，
  //   也正是 yETH 事件里被破坏的那一条。中间某一步若短暂失同步（哪怕最后又对上了），
  //   就意味着存在一个可被利用的窗口——攻击者只需在那个窗口插入一笔操作即可。
  //   所以这里连续做 存→赎→存→赎 四次操作，每一步之后都断言三方恒等。
  it("DR-07 状态一致性：任一操作后三方恒等（getPoolBalance == 真实余额 == totalSupply）", async () => {
    const { alice, assetToken, shareToken, pool } = ctx;

    const steps = [
      { action: "deposit", amount: 500n, label: "存 500" },
      { action: "redeem", amount: 200n, label: "赎 200" },
      { action: "deposit", amount: 120n, label: "再存 120" },
      { action: "redeem", amount: 420n, label: "全赎 420" },
    ];

    let expected = 0n;
    let prev = await snapshotState(pool, assetToken, shareToken, [alice]);

    for (const step of steps) {
      if (step.action === "deposit") {
        await (await pool.connect(alice).deposit(step.amount)).wait();
        expected += step.amount;
      } else {
        await (await pool.connect(alice).redeem(step.amount)).wait();
        expected -= step.amount;
      }

      const curr = await snapshotState(pool, assetToken, shareToken, [alice]);
      printBeforeAfterLine(`DR-07 ${step.label}`, prev, curr);

      // 每一步都做三方恒等校验；任一时刻失同步都算缺陷
      await expectPoolState(pool, assetToken, expected, expected);
      prev = curr;
    }

    // 收尾：全部赎回后归零，资产精确回到初始值
    expect(prev.users[0].shares, "最后一笔全赎之后凭证应归零").to.equal(0n);
    expect(prev.users[0].assets, "全部取回后资产应精确回到初始值").to.equal(INITIAL_MINT);
  });
});
