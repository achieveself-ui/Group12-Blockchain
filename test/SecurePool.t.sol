// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PoolAsserts, IPoolView, IPoolErrors} from "./utils/PoolAsserts.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

// ⚠️⚠️⚠️ 以下是 B 的正式合约（组长文件 4.1 固定接口）⚠️⚠️⚠️
// "测试先行"的预期状态：B 交付 src/ 前本文件无法编译（forge build 报找不到文件），
// 这不是错误——合约到位的当天本骨架即可编译运行，无需再改测试。
import {SecurePool} from "src/SecurePool.sol";
import {PoolShareToken} from "src/PoolShareToken.sol";

/* ==========================================================================
 * SecurePoolTest —— 修复版池子的测试骨架（后续场景的书写范式）
 * --------------------------------------------------------------------------
 * 覆盖 test-plan 中的场景：NP-01（首次存款 1:1）、EX-01（零数量 revert）、
 * PM-02（暂停阻断 + 恢复）。后续场景照抄这三个用例的"三段式"结构即可：
 *   (1) 预声明期望（事件 / revert）
 *   (2) 发起交易（vm.prank 切换身份）
 *   (3) 事后断言（用户视角 + assertPoolState 全局视角）
 * ========================================================================== */
contract SecurePoolTest is PoolAsserts {
    MockERC20 internal asset; // 测试资产（B 交付 TestToken.sol 后在 setUp 替换，其余零改动）
    SecurePool internal pool; // 被测合约：修复版
    PoolShareToken internal share; // 凭证代币（mint/burn 仅池合约可调）

    // 测试账户约定与 test-plan §3.3 保持一致
    address internal admin; // 管理员 = 部署者（Ownable）
    address internal alice; // 正常用户
    address internal bob; // 正常用户
    address internal eve; // 非授权用户（后续 PM-01/04 使用）

    uint256 internal constant INITIAL_ASSETS = 1_000_000e18;

    /* ══════════════════ 部署假设（与 B 对齐，如有出入只改 setUp 这一段）══════════════════
     * A1: PoolShareToken 构造函数接收资金池地址并授予 mint/burn 权限
     *     → new PoolShareToken(address(pool))
     * A2: SecurePool 无参构造，部署者即 owner（OpenZeppelin Ownable）
     * A3: initialize(address assetToken, address shareToken) 只允许成功一次，
     *     由部署流程调用（组长文件 4.3）
     * A4: 自定义错误名见 PoolAsserts.sol 的 IPoolErrors（B 定稿后同步该文件）
     * ═══════════════════════════════════════════════════════════════════════════════════ */

    function setUp() public {
        // ---------- 1. 测试账户 ----------
        // makeAddr 生成确定性标签地址，测试报告里直接显示 "alice" 而不是一串十六进制
        admin = makeAddr("admin");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        eve = makeAddr("eve");

        // ---------- 2. 以 admin 身份部署三份合约并初始化（假设 A2/A3）----------
        vm.startPrank(admin); // 后续所有部署的 msg.sender 都是 admin
        asset = new MockERC20("Test Token", "TTK"); // TODO: B 交付后换 src/TestToken.sol
        pool = new SecurePool(); // A2: owner = admin
        share = new PoolShareToken(address(pool)); // A1: 凭证 mint/burn 仅池可调
        pool.initialize(address(asset), address(share)); // A3: 一次性初始化
        vm.stopPrank();

        // ---------- 3. 部署自检：组长文件 4.1 的三个视图接口 ----------
        // 任何假设错误在 setUp 就爆炸，而不是拖到几十个用例里逐个失败
        assertTrue(IPoolView(address(pool)).initialized(), "setUp: initialized() must be true");
        assertEq(IPoolView(address(pool)).owner(), admin, "setUp: owner must be admin");
        assertEq(IPoolView(address(pool)).shareToken(), address(share), "setUp: shareToken() mismatch");

        // ---------- 4. 给测试账户派发资产并授权资金池 ----------
        vm.prank(admin);
        asset.mint(alice, INITIAL_ASSETS); // Mock 的 mint 仅 owner 可调，所以用 admin 身份
        vm.prank(admin);
        asset.mint(bob, INITIAL_ASSETS);

        vm.prank(alice);
        asset.approve(address(pool), type(uint256).max); // 测试用无限授权，省去逐场景管额度
        vm.prank(bob);
        asset.approve(address(pool), type(uint256).max);

        // ---------- 5. 基线断言：空池 ----------
        assertPoolState(address(asset), address(pool), address(share), 0, 0, "setUp: empty pool");
    }

    /* ------------------------------------------------------------------------
     * 场景 NP-01（test-plan §5.1）：首次存款按 1:1 铸凭证
     * 范式要点：三层断言缺一不可——
     *   事件层（链上审计线索）、用户层（alice 拿到多少凭证）、
     *   全局层（池内资产 / 总供应量 / 账实一致）。
     * 组长文件第 6 节明确要求："不能只看交易是否报错"。
     * ------------------------------------------------------------------------ */
    function test_FirstDeposit_MintsOneToOneShares() public {
        // (1) 事件预声明：期望 Deposited(alice, 1000e18, 1000e18)
        //     Foundry 的 expectEmit 是"先声明期望、后触发交易"的模式
        expectDeposited(alice, 1_000e18, 1_000e18);

        // (2) 以 alice 身份存入 1000 token（组长文件 4.3：1:1 教学规则）
        vm.prank(alice);
        pool.deposit(1_000e18);

        // (3) 用户视角：从凭证余额读结果，而不是依赖 deposit 的返回值
        //     —— 这正是"必查数据"纪律：以链上状态为准
        uint256 shares = IERC20(address(share)).balanceOf(alice);
        assertEq(shares, 1_000e18, "NP-01: shares must equal assets (1:1)");

        // (4) 铸币合理性：1:1 下 toleranceBps = 0（零容忍，任何偏差直接失败）
        //     这个工具后续会在 VulnerablePool 的 16-wei PoC 里反向使用：
        //     存 16 wei 铸 2.35e23 → 本断言失败 → 失败输出就是攻击的量化证据
        assertSharesReasonable(1_000e18, shares, 0);

        // (5) 全局状态一次查完：资产 / 总供应量 / 账实一致（INV-03）
        assertPoolState(address(asset), address(pool), address(share), 1_000e18, 1_000e18, "NP-01");
    }

    /* ------------------------------------------------------------------------
     * 场景 EX-01（test-plan §5.2）：零数量存款必须 revert
     * 范式要点：revert 断言之后必须补一次状态断言——
     * "交易被拒绝"不等于"状态没被改坏"（防止半更新的原子性缺陷）。
     * ------------------------------------------------------------------------ */
    function test_DepositZero_Reverts() public {
        // 期望自定义错误 ZeroAmount（A4：错误名以 B 定稿的 api-spec.md 为准）
        vm.prank(alice);
        expectRevertWith(IPoolErrors.ZeroAmount.selector);
        pool.deposit(0);

        // revert 后池状态必须原封不动
        assertPoolState(address(asset), address(pool), address(share), 0, 0, "EX-01: state unchanged");
    }

    /* ------------------------------------------------------------------------
     * 场景 PM-02（test-plan §5.3，简化版）：暂停期间存款被拒、恢复后正常
     * 范式要点：权限类场景的完整写法——
     *   事件（Paused/Unpaused 的 account 必须是 admin）
     *   + 被拒操作（EnforcedPause）
     *   + 暂停期间状态不变
     *   + 恢复后功能完全正常（不能只测"锁住了"，还要测"钥匙还能开"）。
     * ------------------------------------------------------------------------ */
    function test_PauseBlocksDeposit_ResumeWorks() public {
        // (1) 管理员暂停，事件断言 account == admin
        vm.prank(admin);
        expectPaused(admin);
        pool.pause();
        assertTrue(IPoolView(address(pool)).paused(), "PM-02: must be paused");

        // (2) 暂停期间 alice 存款 → revert（若 B 用 OZ Pausable，默认错误即 EnforcedPause）
        vm.prank(alice);
        expectRevertWith(IPoolErrors.EnforcedPause.selector);
        pool.deposit(1e18);

        // (3) 暂停期间池状态不变
        assertPoolState(address(asset), address(pool), address(share), 0, 0, "PM-02: paused");

        // (4) 管理员恢复，事件断言 account == admin
        vm.prank(admin);
        expectUnpaused(admin);
        pool.unpause();

        // (5) 恢复后存款正常，1:1 定价不变
        vm.prank(alice);
        pool.deposit(1e18);
        assertPoolState(address(asset), address(pool), address(share), 1e18, 1e18, "PM-02: resumed");
    }
}
