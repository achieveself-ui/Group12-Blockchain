// ============================================================================
// test/secure-pool.test.js
// ----------------------------------------------------------------------------
// 【这个文件负责什么】
//   SecurePool 的「拒绝能力」：异常输入、余额不足、池内资产不足、授权缺失、
//   越权操作、错误状态（暂停 / 重复初始化）、凭证铸造权限、异常铸币防护。
//   正常业务见 deposit-redeem.test.js，漏洞演示见 vulnerable-demo.test.js。
//   对应 test-plan.md 的 B / C / D 组：SEC-01 ~ SEC-12。
//
// 【核心判据：revert + 状态零改动】
//   只断言"交易回滚"是不够的。一个只判断 revert 的测试，发现不了
//   「先扣了钱再回滚」「销毁了一半凭证才失败」这类中间态缺陷。
//   所以本文件每个 it 都是双断言：
//     ① 交易被拒绝（reverted / revertedWithCustomError）
//     ② snapshotState 打快照 → 失败后 expectBalancesUnchanged 逐项比对
//        ③totalSupply ④getPoolBalance() ⑤池真实余额 ①②用户两项，一项变了就算失败
//   test-plan 5.3 第 1 条把"回滚但状态被改"直接定义为失败。
//
// 【错误断言策略（重要，别误读）】
//   要求是"优先 revertedWithCustomError，其次 revertedWith(文本)"。
//   但 docs/api-spec.md 尚未定稿（Q2 错误名清单 / Q3 池内不足的错误类型 /
//   Q4 未 approve 的 revert 来源），此刻写死任何一个错误名都是猜测，会制造假红灯。
//   因此本文件暂用最宽松的 .to.be.reverted，并在每处标注 TODO(api-spec.md) 与候选错误名。
//   ⚠️ 松散断言只是过渡态：在 Q2–Q4 定稿并逐个收紧之前，
//      不得把本文件当作"错误类型已验证"写进 security-report。
//
// 【失败信息要求】
//   所有断言都带中文说明，并且写清"这条失败意味着什么"，
//   例如「期望回滚但交易成功：疑似缺失零值检查」——而不是只丢一个 assert failed。
//
// 【当前状态】B 的合约未落地前运行会报 "Artifact not found"，属预期。
// ============================================================================

const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// ---------------------------------------------------------------------------
// 1. 部署参数：B 定稿后「只改这一块」
// ---------------------------------------------------------------------------
const DECIMALS = 18;
const INITIAL_MINT = ethers.parseUnits("10000", DECIMALS);

// TODO(api-spec.md): 两个代币的构造参数待 B 定稿（Q19）：
//   ① 无参 [] / ② (name,symbol) / ③ (name,symbol,owner)
const TEST_TOKEN_ARGS = [];
const SHARE_TOKEN_ARGS = [];

const POOL_NAME = "SecurePool";

// ---------------------------------------------------------------------------
// 2. 夹具
// ---------------------------------------------------------------------------
async function deployFixture() {
  const [owner, alice, bob, attacker] = await ethers.getSigners();

  const assetToken = await ethers.deployContract("TestToken", TEST_TOKEN_ARGS);
  await assetToken.waitForDeployment();

  const shareToken = await ethers.deployContract("PoolShareToken", SHARE_TOKEN_ARGS);
  await shareToken.waitForDeployment();

  const pool = await ethers.deployContract(POOL_NAME);
  await pool.waitForDeployment();

  // 由 owner 完成初始化：夹具里部署者与初始化者是同一个账户，
  // 因此无论 owner 取 constructor 的 deployer 还是 initialize 的 msg.sender（Q7），
  // 下面的 owner() 断言都成立。
  await pool.initialize(await assetToken.getAddress(), await shareToken.getAddress());

  for (const user of [alice, bob, attacker]) {
    await assetToken.connect(owner).mint(user.address, INITIAL_MINT);
    await assetToken.connect(user).approve(await pool.getAddress(), ethers.MaxUint256);
  }

  return { owner, alice, bob, attacker, assetToken, shareToken, pool };
}

// ---------------------------------------------------------------------------
// 3. 内联断言 / 观测 / 构造工具
// ---------------------------------------------------------------------------
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

function printBeforeAfterLine(label, before, after, userIndex = 0) {
  const b = before.users[userIndex];
  const a = after.users[userIndex];

  console.log(
    `[${label}] 前: ①${b.assets} ②${b.shares} ③${before.totalSupply} ④${before.poolBalance} ⑤${before.poolRealAssets}` +
      ` | 后: ①${a.assets} ②${a.shares} ③${after.totalSupply} ④${after.poolBalance} ⑤${after.poolRealAssets}`
  );
}

/** 三方恒等：getPoolBalance() == 池真实余额 == totalSupply */
async function expectPoolState(pool, token, expectedPoolBalance, expectedTotalSupply) {
  const shareToken = await ethers.getContractAt("PoolShareToken", await pool.shareToken());
  const poolAddress = await pool.getAddress();

  expect(await pool.getPoolBalance(), "④ getPoolBalance() 与期望不符").to.equal(BigInt(expectedPoolBalance));
  expect(await token.balanceOf(poolAddress), "⑤ 池真实代币余额与期望不符").to.equal(BigInt(expectedPoolBalance));
  expect(await shareToken.totalSupply(), "③ totalSupply 与期望不符").to.equal(BigInt(expectedTotalSupply));
}

/**
 * 「回滚后状态未改变」的唯一判据。
 * 注意：它同时校验 ③④⑤，所以只适用于"池子数值本就不该变"的场景——
 * 本文件里绝大多数用例都属于这种情况（交易应当整体失败）。
 */
async function expectBalancesUnchanged(users, tokens, snapshot) {
  const [assetToken, shareToken] = tokens;

  for (let i = 0; i < users.length; i++) {
    const address = users[i].address || users[i];
    expect(await assetToken.balanceOf(address), `回滚后 ${address} 的资产余额被改动`).to.equal(
      snapshot.users[i].assets
    );
    expect(await shareToken.balanceOf(address), `回滚后 ${address} 的凭证余额被改动`).to.equal(
      snapshot.users[i].shares
    );
  }

  expect(await shareToken.totalSupply(), "回滚后凭证 totalSupply 被改动").to.equal(snapshot.totalSupply);
  expect(await pool.getPoolBalance(), "回滚后 getPoolBalance() 被改动").to.equal(snapshot.poolBalance);
  expect(
    await assetToken.balanceOf(await snapshot.pool.getAddress()),
    "回滚后池合约真实代币余额被改动"
  ).to.equal(snapshot.poolRealAssets);
}

/**
 * 构造「池内资产不足」的局面：把池合约持有的资产转走一部分。
 *
 * 为什么用这招：资产只在池合约名下，普通账户没有权限把它转出，
 * 而池合约本身也没有"取出"的对外函数（也不该有）。
 * 在本地链上可以通过 impersonateAccount 以池合约的身份发交易，
 * 模拟"池内资产被外部因素抽走"（清算、捐赠、其它合约调用等），
 * 这比"改合约代码加一个后门"干净得多——C 不改 B 的代码。
 *
 * 注意：该手法只在 Hardhat 本地链可用（本文件与 vulnerable-demo 一样，只跑本地链）。
 */
async function drainPoolAssets(ctx, to, amount) {
  const poolAddress = await ctx.pool.getAddress();

  // 给伪造身份一点原生币付 gas（只影响 ETH 余额，不影响 ERC-20 账目）
  await network.provider.send("hardhat_setBalance", [poolAddress, "0x21e19e0c9bab2400000"]); // 10000 ETH
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [poolAddress] });

  try {
    const poolSigner = await ethers.getSigner(poolAddress);
    await (await ctx.assetToken.connect(poolSigner).transfer(to, amount)).wait();
    console.log(`【构造】已从池合约转出 ${amount} 资产到 ${to.address}（本地链模拟"池内资产被抽走"）`);
  } finally {
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [poolAddress] });
  }
}

/** 从交易回执里取指定事件的解析结果（用于核对事件字段，而不只是"发出过"）。 */
function findEvent(pool, receipt, name) {
  return receipt.logs
    .map((log) => {
      try {
        return pool.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === name);
}

// ---------------------------------------------------------------------------
// 4. 用例
// ---------------------------------------------------------------------------

describe("输入边界", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // SEC-01：deposit(0)
  // 为什么零值必须被拒绝：1:1 下 deposit(0) 铸出 0 凭证，看似"无害"，
  // 但它会发出一条 Deposited(0,0) 事件，并可能触碰记账变量，
  // 成为后续异常状态的入口——教学版正是从这类"无害边界"被打开缺口的。
  it("SEC-01 deposit(0) 必须回滚，且回滚后 totalSupply / getPoolBalance / 用户余额全部不变", async () => {
    const { alice, assetToken, shareToken, pool } = ctx;

    // 先存一笔，让账上有真实数字，否则"不变"没有说服力
    await (await pool.connect(alice).deposit(500n)).wait();

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("SEC-01 调用 deposit(0) 之前", before);

    // TODO(api-spec.md): Q2 错误名定稿后改为
    //   .to.be.revertedWithCustomError(pool, "ZeroAmount") 或 .to.be.revertedWith("amount must be > 0")
    await expect(
      pool.connect(alice).deposit(0),
      "期望回滚但交易成功：deposit(0) 被接受，疑似缺失零值检查"
    ).to.be.reverted;

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("SEC-01 deposit(0) 之后", before, after);

    await expectBalancesUnchanged([alice], [assetToken, shareToken], before);
  });

  // SEC-02：redeem(0)
  it("SEC-02 redeem(0) 必须回滚，且回滚后 totalSupply / getPoolBalance / 用户余额全部不变", async () => {
    const { alice, assetToken, shareToken, pool } = ctx;

    await (await pool.connect(alice).deposit(500n)).wait();

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("SEC-02 调用 redeem(0) 之前", before);

    // TODO(api-spec.md): Q2 → revertedWithCustomError(pool, "ZeroShares")
    await expect(
      pool.connect(alice).redeem(0),
      "期望回滚但交易成功：redeem(0) 被接受，疑似缺失零值检查"
    ).to.be.reverted;

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("SEC-02 redeem(0) 之后", before, after);

    await expectBalancesUnchanged([alice], [assetToken, shareToken], before);
  });
});

describe("余额与池内资产不足", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // SEC-03：赎回超过自身凭证余额
  // 关键在"不得部分销毁"：有的实现会先 burn 能 burn 的部分再报错，
  // 结果是用户凭证被扣、资产没拿到。所以这里既断言 revert，也断言 ② 仍是 500。
  it("SEC-03 redeem(凭证余额 + 1) 必须回滚，且不得部分销毁", async () => {
    const { alice, assetToken, shareToken, pool } = ctx;

    await (await pool.connect(alice).deposit(500n)).wait();
    const aliceShares = await shareToken.balanceOf(alice.address);

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("SEC-03 超额赎回之前", before);

    // TODO(api-spec.md): Q2 → 候选 InsufficientShares / ERC20InsufficientBalance（若由 burn 触发）
    await expect(
      pool.connect(alice).redeem(aliceShares + 1n),
      "期望回滚但交易成功：赎回超过自身凭证余额却被接受，疑似缺失余额校验"
    ).to.be.reverted;

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("SEC-03 超额赎回之后", before, after);

    expect(after.users[0].shares, "回滚后用户凭证被扣减：疑似部分销毁").to.equal(aliceShares);
    await expectBalancesUnchanged([alice], [assetToken, shareToken], before);
  });

  // SEC-04：池内资产不足
  // 构造方式：把池内 400 转走，此时池内真实资产 100，但 alice 手里有 500 凭证。
  // 快照必须在"转走资产之后"取——否则构造动作本身造成的变化会被误判成"回滚后状态被改"。
  it("SEC-04 池内资产不足时 redeem 必须整体回滚，不得部分成功", async () => {
    const { owner, alice, assetToken, shareToken, pool } = ctx;

    await (await pool.connect(alice).deposit(500n)).wait();
    await drainPoolAssets(ctx, owner, 400n); // 池内真实资产 500 → 100

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("SEC-04 构造完成：池内资产已不足", before);
    console.log(`【局面】待赎回 500 凭证，池内真实资产仅 ${before.poolRealAssets}`);

    // TODO(api-spec.md): Q3 —— 池内不足是抛自定义错误（如 InsufficientPoolAssets），
    // 还是让 ERC-20 转账失败后冒泡 ERC20InsufficientBalance？两者签名互斥，定稿后收紧。
    await expect(
      pool.connect(alice).redeem(500n),
      "期望回滚但交易成功：池内资产不足却完成了赎回，疑似缺失池内余额校验"
    ).to.be.reverted;

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("SEC-04 赎回失败之后", before, after);

    // 不得部分成功：凭证一张都不能少
    expect(after.users[0].shares, "回滚后凭证被销毁：出现部分成功").to.equal(500n);
    await expectBalancesUnchanged([alice], [assetToken, shareToken], before);
  });
});

describe("授权缺失", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // SEC-05：未 approve 就 deposit
  // 预期行为说明：这个 revert 来自 ERC-20 的 transferFrom，而不是池子自己的校验。
  // 换句话说，池子的"已 approve"前提是由底层代币保证的，不是它自己检查的——
  // 这一点要写进 security-report，避免把"ERC-20 帮忙拦住了"误记成"我们做了授权校验"。
  it("SEC-05 未 approve 就 deposit 必须回滚（错误来自 ERC-20，属预期行为）", async () => {
    const { bob, assetToken, shareToken, pool } = ctx;

    // bob 撤销授权，构造"未 approve"状态
    await (await assetToken.connect(bob).approve(await pool.getAddress(), 0)).wait();

    const before = await snapshotState(pool, assetToken, shareToken, [bob]);
    printStateTable("SEC-05 未授权状态下存款之前", before);

    // TODO(api-spec.md): Q4 —— 若确认池子会先自检并抛自定义错误，改为
    //   .to.be.revertedWithCustomError(pool, "NotApproved")；否则用
    //   .to.be.revertedWithCustomError(assetToken, "ERC20InsufficientAllowance")
    await expect(
      pool.connect(bob).deposit(100n),
      "期望回滚但交易成功：未授权也完成了转账，疑似绕过 allowance"
    ).to.be.reverted;

    const after = await snapshotState(pool, assetToken, shareToken, [bob]);
    printBeforeAfterLine("SEC-05 存款失败之后", before, after);

    await expectBalancesUnchanged([bob], [assetToken, shareToken], before);
  });
});

describe("权限：pause / unpause 只属于 owner", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // SEC-06 / SEC-07 共用一个前置：owner() 必须与部署者一致。
  // owner 是谁（Q7）会影响"用哪个账户扮演非 owner"，但不会影响这两个用例的结论。
  it("SEC-06 非 owner 调 pause() 必须回滚，paused() 仍为 false", async () => {
    const { owner, bob, assetToken, shareToken, pool } = ctx;

    expect(await pool.owner(), "owner() 应与部署者一致（Q7：若由 initialize 的 msg.sender 决定，本夹具中两者相同）").to.equal(
      owner.address
    );

    const before = await snapshotState(pool, assetToken, shareToken, [bob]);
    printStateTable("SEC-06 非 owner 暂停之前", before);

    // TODO(api-spec.md): Q2 → 候选 NotOwner() / OwnableUnauthorizedAccount(bob)
    await expect(
      pool.connect(bob).pause(),
      "期望回滚但交易成功：非 owner 成功暂停，疑似缺失访问控制（P0）"
    ).to.be.reverted;

    expect(await pool.paused(), "回滚后 paused() 被置为 true：权限校验形同虚设").to.equal(false);
    await expectBalancesUnchanged([bob], [assetToken, shareToken], before);
  });

  it("SEC-07 非 owner 调 unpause() 必须回滚，paused() 仍为 true", async () => {
    const { owner, bob, assetToken, shareToken, pool } = ctx;

    // 先由 owner 合法暂停
    await (await pool.connect(owner).pause()).wait();
    expect(await pool.paused(), "前置失败：owner 未能暂停").to.equal(true);

    const before = await snapshotState(pool, assetToken, shareToken, [bob]);
    printStateTable("SEC-07 非 owner 解除暂停之前", before);

    await expect(
      pool.connect(bob).unpause(),
      "期望回滚但交易成功：非 owner 成功解除暂停，疑似缺失访问控制（P0）"
    ).to.be.reverted;

    expect(await pool.paused(), "回滚后 paused() 变成 false：非 owner 绕过了暂停开关").to.equal(true);
    await expectBalancesUnchanged([bob], [assetToken, shareToken], before);
  });
});

describe("暂停状态机", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // SEC-08
  // 最容易被写漏的一条：只测"存款被拒"，忘了测"查询仍可用"。
  // 暂停不应冻结只读接口——否则前端、监控、审计全部失效，
  // 而且"暂停期间连余额都读不到"本身就是一个可用性缺陷。
  it("SEC-08 暂停后 deposit/redeem 回滚且余额不变，但查询函数仍正常", async () => {
    const { owner, alice, assetToken, shareToken, pool } = ctx;

    await (await pool.connect(alice).deposit(500n)).wait();

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("SEC-08 暂停之前", before);

    // —— owner 暂停 ——
    const pauseTx = await pool.connect(owner).pause();
    const pauseReceipt = await pauseTx.wait();

    expect(await pool.paused(), "pause() 之后 paused() 必须为 true").to.equal(true);
    await expect(pauseTx, "pause() 未发出 Paused 事件").to.emit(pool, "Paused").withArgs(owner.address);

    const pausedEvent = findEvent(pool, pauseReceipt, "Paused");
    expect(pausedEvent, "回执中找不到 Paused 事件").to.not.equal(undefined);
    expect(pausedEvent.args.account, "Paused 事件的 account 应为调用者").to.equal(owner.address);

    // —— 写操作必须被拒 ——
    // TODO(api-spec.md): Q2/Q10 → 候选 EnforcedPause() / PoolPaused()
    await expect(
      pool.connect(alice).deposit(100n),
      "期望回滚但交易成功：暂停期间存款被接受，疑似 pause 校验缺失（P0）"
    ).to.be.reverted;

    await expect(
      pool.connect(alice).redeem(100n),
      "期望回滚但交易成功：暂停期间赎回被接受，疑似 pause 校验缺失（P0）"
    ).to.be.reverted;

    // —— 查询必须仍然可用（不是"回滚"，而是"正常返回且数值不变"）——
    const pausedPoolBalance = await pool.getPoolBalance();
    const pausedSupply = await shareToken.totalSupply();
    const pausedUserShares = await shareToken.balanceOf(alice.address);
    const pausedFlag = await pool.paused();

    expect(pausedPoolBalance, "暂停期间 getPoolBalance() 应可正常读取").to.equal(before.poolBalance);
    expect(pausedSupply, "暂停期间 totalSupply() 应可正常读取").to.equal(before.totalSupply);
    expect(pausedUserShares, "暂停期间 balanceOf() 应可正常读取").to.equal(before.users[0].shares);
    expect(pausedFlag, "暂停期间 paused() 应可正常读取").to.equal(true);
    console.log(
      `【查询可用性】暂停期间读数正常：④${pausedPoolBalance} ③${pausedSupply} ②${pausedUserShares} paused=${pausedFlag}`
    );

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("SEC-08 暂停期间两次写操作失败之后", before, after);
    await expectBalancesUnchanged([alice], [assetToken, shareToken], before);
  });

  // SEC-09
  it("SEC-09 unpause() 后恢复：paused()==false、发出 Unpaused、存款按 1:1 成功", async () => {
    const { owner, alice, assetToken, shareToken, pool } = ctx;

    // 前置：先由 owner 合法暂停，才能验证"解除暂停"这一侧
    await (await pool.connect(owner).pause()).wait();
    expect(await pool.paused(), "前置失败：owner 未能暂停").to.equal(true);

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("SEC-09 解除暂停之前", before);

    const unpauseTx = await pool.connect(owner).unpause();
    const unpauseReceipt = await unpauseTx.wait();

    expect(await pool.paused(), "unpause() 之后 paused() 必须为 false").to.equal(false);
    await expect(unpauseTx, "unpause() 未发出 Unpaused 事件").to.emit(pool, "Unpaused").withArgs(owner.address);

    const unpausedEvent = findEvent(pool, unpauseReceipt, "Unpaused");
    expect(unpausedEvent, "回执中找不到 Unpaused 事件").to.not.equal(undefined);
    expect(unpausedEvent.args.account, "Unpaused 事件的 account 应为调用者").to.equal(owner.address);

    // 恢复后存款必须成功，并严格 1:1
    const depositTx = await pool.connect(alice).deposit(100n);
    await depositTx.wait();

    const after = await snapshotState(pool, assetToken, shareToken, [alice]);
    printBeforeAfterLine("SEC-09 解除暂停并存款 100 之后", before, after);

    expect(after.users[0].shares, "恢复后存款未按 1:1 铸出凭证").to.equal(100n);
    await expectPoolState(pool, assetToken, 100n, 100n);
    await expect(depositTx).to.emit(pool, "Deposited").withArgs(alice.address, 100n, 100n);
  });
});

describe("初始化与凭证铸造权限", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // SEC-10：重复初始化
  // 除了"第二次必须回滚"，还要证明"回滚了且状态没被顺手改掉"：
  // 有些实现会先写入新地址再检查 initialized，然后回滚——链上状态虽回滚了，
  // 但若实现里漏了 revert（只 return），就会出现"看起来拦住、其实被改写"。
  // 这里用两个手段验证：shareToken() 不变 + 用原资产代币仍能正常存款。
  it("SEC-10 二次 initialize 必须回滚，且 initialized()/shareToken() 未被改写", async () => {
    const { owner, alice, assetToken, shareToken, pool } = ctx;

    // 前置：已初始化一次
    const initializedBefore = await pool.initialized();
    const shareTokenBefore = await pool.shareToken();
    console.log(
      `\n【二次初始化前】initialized()=${initializedBefore}  shareToken()=${shareTokenBefore}`
    );
    expect(initializedBefore, "首次 initialize 后 initialized() 应为 true").to.equal(true);

    // 准备一套全新代币，作为"第二次调用要写入的恶意参数"
    const assetToken2 = await ethers.deployContract("TestToken", TEST_TOKEN_ARGS);
    await assetToken2.waitForDeployment();
    const shareToken2 = await ethers.deployContract("PoolShareToken", SHARE_TOKEN_ARGS);
    await shareToken2.waitForDeployment();

    const before = await snapshotState(pool, assetToken, shareToken, [alice]);
    printStateTable("SEC-10 二次 initialize 之前", before);

    // TODO(api-spec.md): Q2/Q8 → 候选 AlreadyInitialized()；并确认"参数完全相同"也必须回滚
    await expect(
      pool.connect(owner).initialize(await assetToken2.getAddress(), await shareToken2.getAddress()),
      "期望回滚但交易成功：二次 initialize 被接受，疑似缺失一次性保护（P0）"
    ).to.be.reverted;

    const initializedAfter = await pool.initialized();
    const shareTokenAfter = await pool.shareToken();

    console.log(`\n───── 二次 initialize 前后对照 ─────`);
    console.table([
      { 时点: "调用前", "initialized()": initializedBefore.toString(), "shareToken()": shareTokenBefore },
      { 时点: "调用失败后", "initialized()": initializedAfter.toString(), "shareToken()": shareTokenAfter },
    ]);

    expect(initializedAfter, "回滚后 initialized() 被改成 false").to.equal(true);
    expect(shareTokenAfter, "回滚后 shareToken() 被改写：二次初始化虽回滚但状态被污染").to.equal(shareTokenBefore);

    // Q5：固定接口没有 assetToken() getter，无法直接读资产地址；
    // 用"原资产代币仍能正常完成存款"间接证明资产记录未被换成 assetToken2。
    await (await pool.connect(alice).deposit(100n)).wait();
    expect(await shareToken.balanceOf(alice.address), "使用原资产代币存款失败：资产地址记录疑似被改写").to.equal(
      100n
    );
  });

  // SEC-11：凭证铸造权限
  // "只有池合约能 mint/burn"这条，必须用普通地址 + owner 两种身份都试，
  // 因为最常见的实现错误就是 onlyOwner 而不是 onlyPool——那等于管理员能凭空印钱。
  it("SEC-11 非池合约调 PoolShareToken.mint/burn 必须回滚，totalSupply 不变", async () => {
    const { owner, alice, bob, assetToken, shareToken, pool } = ctx;

    await (await pool.connect(alice).deposit(500n)).wait();
    const supplyBefore = await shareToken.totalSupply();

    const before = await snapshotState(pool, assetToken, shareToken, [alice, bob]);
    printStateTable("SEC-11 越权铸造之前", before);

    // ① 普通账户直接 mint
    // TODO(api-spec.md): Q19 → mint 的签名与错误名待定稿：
    //   若为 mint(address,uint256) 用下面的写法；若为 mint(uint256)（只给自己铸），去掉首参；
    //   错误名候选 NotPool() / OnlyPool()。
    await expect(
      shareToken.connect(bob).mint(bob.address, 1000n),
      "期望回滚但交易成功：普通账户可以增发凭证，等同凭空印钱（P0）"
    ).to.be.reverted;

    // ② owner 直接 mint（如果实现写成 onlyOwner，这条会失败——那正是要抓的缺陷）
    await expect(
      shareToken.connect(owner).mint(owner.address, 1000n),
      "期望回滚但交易成功：owner 可以增发凭证，权限模型写成了 onlyOwner 而非 onlyPool（P0）"
    ).to.be.reverted;

    // ③ 普通账户直接 burn（销毁他人凭证可制造挤兑恐慌）
    await expect(
      shareToken.connect(bob).burn(alice.address, 1n),
      "期望回滚但交易成功：普通账户可以销毁他人凭证（P0）"
    ).to.be.reverted;

    expect(await shareToken.totalSupply(), "越权操作失败后 totalSupply 仍被改动").to.equal(supplyBefore);
    await expectBalancesUnchanged([alice, bob], [assetToken, shareToken], before);

    // ④ 只有走 pool.deposit() 才会增加供应量
    await (await pool.connect(alice).deposit(100n)).wait();
    expect(await shareToken.totalSupply(), "池子正常存款未使 totalSupply 增加").to.equal(supplyBefore + 100n);
  });
});

describe("异常铸币防护", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await deployFixture();
  });

  // SEC-12：把漏洞版会出问题的同一组输入原样喂给修复版。
  // 判据是"二选一"：要么回滚，要么铸出的凭证严格等于存入量——
  // 两者都不允许出现第三种结果（例如"成功了但多铸"）。
  // 因为不知道实现会用哪种方式拒绝（零值/上限/状态校验），这里用 try/catch 分支，
  // 而不是把某一种拒绝方式写死：写死会制造假红灯，掩盖真正的结论。
  it("SEC-12 复用漏洞版边界输入：要么回滚，要么严格 1:1，绝不超额铸币", async () => {
    const { alice, attacker, assetToken, shareToken, pool } = ctx;

    // ① 先把池子清空，制造与漏洞演示相同的"零供应量 + 池内为空"局面
    await (await pool.connect(alice).deposit(500n)).wait();
    await (await pool.connect(alice).redeem(500n)).wait();

    const emptied = await snapshotState(pool, assetToken, shareToken, [attacker]);
    printStateTable("SEC-12 池子已清空（与漏洞版同一起点）", emptied);

    // ② 微额存款 16 最小单位
    const dust = 16n;
    const before = await snapshotState(pool, assetToken, shareToken, [attacker]);

    let reverted = false;
    let minted = 0n;
    try {
      await (await pool.connect(attacker).deposit(dust)).wait();
      minted = await shareToken.balanceOf(attacker.address);
    } catch (error) {
      reverted = true;
      console.log(`【结果 A】交易被拒绝，原因：${error.shortMessage || error.message}`);
    }

    const after = await snapshotState(pool, assetToken, shareToken, [attacker]);
    printBeforeAfterLine("SEC-12 微额存款 16 之后", before, after);

    if (reverted) {
      // 分支 A：拒绝了。但"拒绝了"不等于"干净地拒绝了"——状态必须一点没动。
      await expectBalancesUnchanged([attacker], [assetToken, shareToken], before);
      console.log("【结论】修复版选择回滚；已确认状态零改动。");
    } else {
      // 分支 B：接受了。那就必须严格 1:1，且三方恒等。
      expect(minted, "异常铸币：存入 16 却铸出不等量的凭证，与漏洞版同一缺陷（P0）").to.equal(dust);
      await expectPoolState(pool, assetToken, dust, dust);
      console.log(`【结论】修复版接受了微额存款，但严格 1:1（铸出 ${minted}），未被放大。`);
    }

    // ③ 极端金额：赎回 uint256.max 必须被拒（凭证不足 / 池内不足），不得出现算术回绕
    const beforeMax = await snapshotState(pool, assetToken, shareToken, [attacker]);
    await expect(
      pool.connect(attacker).redeem(ethers.MaxUint256),
      "期望回滚但交易成功：redeem(uint256.max) 被接受，疑似算术回绕或缺失余额校验（P0）"
    ).to.be.reverted;

    const afterMax = await snapshotState(pool, assetToken, shareToken, [attacker]);
    printBeforeAfterLine("SEC-12 redeem(uint256.max) 失败之后", beforeMax, afterMax);
    await expectBalancesUnchanged([attacker], [assetToken, shareToken], beforeMax);
  });
});
