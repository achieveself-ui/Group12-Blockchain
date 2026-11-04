// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/* ==========================================================================
 * DeFi Shield · 测试断言库（C 的测试基建）
 * --------------------------------------------------------------------------
 * 组长文件 4.1/4.2 固定接口在测试侧的声明：
 * 所有测试断言都以这三个 interface 为唯一定义点；B 定稿后若事件 indexed
 * 位置、错误命名有出入，只需改本文件，不用逐个改测试用例。
 * ========================================================================== */

/// @dev 资金池只读视图（组长文件 4.1 固定接口）
interface IPoolView {
    function getPoolBalance() external view returns (uint256); // 池内实际资产
    function shareToken() external view returns (address);     // 凭证代币地址
    function initialized() external view returns (bool);       // 是否完成初始化
    function paused() external view returns (bool);            // 是否暂停
    function owner() external view returns (address);           // 管理员（Ownable）
}

/// @dev 统一事件（组长文件 4.2 固定字段）
interface IPoolEvents {
    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Redeemed(address indexed user, uint256 shares, uint256 assets);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
}

/// @dev 自定义错误声明（⚠️ 以 B 定稿的 api-spec.md 为准，命名如不同只改这里；
///      若 B 用 require 字符串，改用 vm.expectRevert("...") 断言）
interface IPoolErrors {
    error ZeroAmount();                                      // deposit(0) / redeem(0)
    error InsufficientShares();                              // 赎回超过自身凭证余额
    error InsufficientPoolAssets();                          // 池内资产不足
    error AlreadyInitialized();                              // 重复 initialize
    error EnforcedPause();                                    // OZ Pausable 默认
    error OwnableUnauthorizedAccount(address account);        // OZ Ownable 默认
}

/// @dev VulnerablePool 教学版的缓存余额 getter。
/// ⚠️ getter 名（cachedPoolBalance）是 C 与 B 的约定占位，B 定稿后同步。
interface IVulnerableCacheView {
    function cachedPoolBalance() external view returns (uint256);
}

/* ==========================================================================
 * PoolAsserts —— 测试合约的公共基类
 * --------------------------------------------------------------------------
 * 设计为 abstract contract（而非 library），原因有二：
 *   1. 事件封装 expectDeposited 等必须"emit 期望事件"，Solidity 只允许
 *      在继承了事件定义的合约里 emit，继承 IPoolEvents 即可零成本做到；
 *   2. 测试合约 `is PoolAsserts` 一次继承，同时获得 forge-std 的全部能力
 *      （vm cheatcode / assertEq / console2），无需在每个文件重复 import。
 * ========================================================================== */
abstract contract PoolAsserts is Test, IPoolEvents {
    /* ----------------------------------------------------------------------
     * 1. assertPoolState：一次性检查池子的"四本账"
     *    - 真实资产：asset.balanceOf(pool)（链上事实，唯一可信来源）
     *    - 会计资产：pool.getPoolBalance()（合约自报）
     *    - 总供应量：share.totalSupply()
     *    - 交叉一致性：真实 == 会计 —— 这正是 16-wei 攻击破坏的不变量 INV-03
     *      （Yearn 事件中"缓存余额残留"就是这两本账失同步的极端形式）
     *    打印在前、断言在后：失败时终端能看到完整快照，而不是只有一行报错。
     * ---------------------------------------------------------------------- */
    function assertPoolState(
        address assetToken,
        address pool,
        address shareToken,
        uint256 expectedAssets,
        uint256 expectedTotalSupply,
        string memory context
    ) internal {
        uint256 real = IERC20(assetToken).balanceOf(pool);
        uint256 accounted = IPoolView(pool).getPoolBalance();
        uint256 supply = IERC20(shareToken).totalSupply();

        console2.log("======== assertPoolState:", context);
        console2.log("  real assets  balanceOf(pool) :", real);
        console2.log("  accounted    getPoolBalance() :", accounted);
        console2.log("  totalSupply  PoolShareToken   :", supply);
        console2.log("  expected assets               :", expectedAssets);
        console2.log("  expected supply               :", expectedTotalSupply);

        assertEq(real, expectedAssets, string.concat(context, ": real assets mismatch"));
        assertEq(
            real,
            accounted,
            string.concat(context, ": getPoolBalance() != balanceOf(pool) — INV-03 账实一致被破坏")
        );
        assertEq(supply, expectedTotalSupply, string.concat(context, ": totalSupply mismatch"));
    }

    /* ----------------------------------------------------------------------
     * 2. assertCacheBalance：VulnerablePool 教学版专用的缓存余额断言。
     *    用 try/catch 是为了兼容 B 尚未暴露 getter 的情况——先打 WARN 跳过，
     *    不让基建在 B 交付中途把测试卡死；getter 定稿后自动生效。
     * ---------------------------------------------------------------------- */
    function assertCacheBalance(address pool, uint256 expectedCache) internal {
        try IVulnerableCacheView(pool).cachedPoolBalance() returns (uint256 cached) {
            console2.log("  cached balance (教学版 packed_vbs) :", cached);
            console2.log("  expected cache                     :", expectedCache);
            assertEq(cached, expectedCache, "cache balance mismatch");
        } catch {
            emit log_string("WARN: pool 未暴露 cachedPoolBalance()，跳过缓存断言（与 B 确认 getter 名）");
        }
    }

    /* ----------------------------------------------------------------------
     * 3. assertSharesReasonable：铸币合理性断言（防异常铸币的核心工具）。
     *    规则：|shares - deposit| <= deposit * toleranceBps / 10_000
     *    - SecurePool 是 1:1 教学规则 → toleranceBps = 0（零容忍，任何偏差即失败）
     *    - VulnerablePool 演示中 shares = 2.35e23 / deposit = 16 → diff 巨大，
     *      断言失败并打印两侧数值 = 直接给出"16-wei 攻击"的量化证据
     *    先打印再断言：失败输出里能直接看到 shares/deposit 的离谱倍数。
     * ---------------------------------------------------------------------- */
    function assertSharesReasonable(
        uint256 depositAmount,
        uint256 mintedShares,
        uint256 toleranceBps
    ) internal {
        require(depositAmount > 0, "assertSharesReasonable: deposit must be > 0");
        uint256 diff = mintedShares > depositAmount
            ? mintedShares - depositAmount
            : depositAmount - mintedShares;
        uint256 tolerance = (depositAmount * toleranceBps) / 10_000;

        if (diff > tolerance) {
            console2.log("======== [异常铸币] shares 超出容忍范围");
            console2.log("  deposit       :", depositAmount);
            console2.log("  shares minted :", mintedShares);
            console2.log("  toleranceBps  :", toleranceBps);
        }
        assertLe(diff, tolerance, "shares/deposit 比例越界（异常铸币防护 SEC-03 / 16-wei 攻击特征）");
    }

    /* ----------------------------------------------------------------------
     * 4. expectRevertWith：统一的自定义错误断言。
     *    bytes4 选择器断言比 revert 字符串断言更严格（防"改了错误内容但
     *    测试仍绿"），且和 B 在 api-spec.md 里登记的错误一一对应。
     * ---------------------------------------------------------------------- */
    function expectRevertWith(bytes4 errorSelector) internal {
        vm.expectRevert(errorSelector);
    }

    /* ----------------------------------------------------------------------
     * 5. 事件封装：Foundry 的 expectEmit 是"预声明"模式——先设置期望、在测试
     *    合约里 emit 期望事件，再发起真实交易。四个 true = 校验事件签名
     *    （topic0）+ 全部 indexed 参数，非 indexed 数据整体比对。
     *    封装成一行，让测试用例读起来就是业务语言：
     *        expectDeposited(alice, 1000e18, 1000e18);
     *        vm.prank(alice); pool.deposit(1000e18);
     * ---------------------------------------------------------------------- */
    function expectDeposited(address user, uint256 assets, uint256 shares) internal {
        vm.expectEmit(true, true, true, true);
        emit Deposited(user, assets, shares);
    }

    function expectRedeemed(address user, uint256 shares, uint256 assets) internal {
        vm.expectEmit(true, true, true, true);
        emit Redeemed(user, shares, assets);
    }

    function expectPaused(address account) internal {
        vm.expectEmit(true, true, true, true);
        emit Paused(account);
    }

    function expectUnpaused(address account) internal {
        vm.expectEmit(true, true, true, true);
        emit Unpaused(account);
    }
}
