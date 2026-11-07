# DeFi Shield 接口草案（B 实现，待 A 审核）

状态：未找到已获 A 确认的 `docs/api-spec.md`；本文件不代表组长批准。固定函数未改变，补充未规定的构造方式、错误和 indexed 细节。批准后由 A 冻结为正式接口。

## 构造、单位与部署顺序

1. 管理员部署 `TestToken()`：无参数，名称 DeFi Shield Test Token，符号 DST，18 decimals，初始供应为 0，部署者为 owner。
2. 同一管理员部署 `SecurePool()`：无参数，部署者为 owner。
3. 部署 `PoolShareToken(poolAddress)`：名称 DeFi Shield Pool Share，符号 DSPS，18 decimals，初始供应为 0。pool 必须为非零、已部署合约；永久绑定，无 setter/owner。
4. 池 owner 调用 `initialize(assetAddress, shareAddress)`，检查回执及 `initialized()`。资产与凭证地址必须不同；必须有代码；凭证绑定此池且供应为零；两种代币 decimals 必须为 18。
5. TestToken owner 给用户 mint；用户调用资产 `approve(pool, amount)`，然后 `deposit(amount)`。赎回不需要 approve 凭证：池从调用者账户直接 burn。

所有金额均为 uint256 最小单位；16 是 16 个最小单位，不是 16 个完整 DST。显示使用 formatUnits(value,18)，输入使用 parseUnits(text,18)，不要经过 JS Number。

## 固定公开接口

| 合约 | 函数 | 返回 | 权限/行为 |
|---|---|---|---|
| TestToken | mint(address to,uint256 amount) | 无 | onlyOwner；标准 ERC20 mint |
| PoolShareToken | mint(address to,uint256 amount) | 无 | 仅 immutable pool |
| PoolShareToken | burn(address from,uint256 amount) | 无 | 仅 immutable pool |
| 两种代币 | totalSupply(), balanceOf(address), allowance(address,address) | uint256 | 标准查询 |
| 两种代币 | transfer(address,uint256), approve(address,uint256), transferFrom(address,address,uint256) | bool | OZ ERC20 标准行为 |
| SecurePool | initialize(address assetToken,address shareToken) | 无 | onlyOwner；只成功一次 |
| SecurePool | deposit(uint256 assets) | 无 | 初始化、未暂停、非重入、assets>0；转入等量资产、铸等量凭证 |
| SecurePool | redeem(uint256 shares) | 无 | 初始化、未暂停、非重入、shares>0；销毁凭证、支付等量资产 |
| SecurePool | getPoolBalance() | uint256 | 实际资产余额；未初始化返回 0 |
| SecurePool | shareToken(), assetToken() | address | 查询；未初始化为零地址 |
| SecurePool | initialized(), paused() | bool | 查询 |
| SecurePool | owner() | address | 管理员查询 |
| SecurePool | pause(), unpause() | 无 | onlyOwner；存款、赎回同时暂停 |
| PoolShareToken | pool() | address | 永久绑定池查询 |

TestToken/SecurePool 另继承 OZ Ownable 的 `transferOwnership(address)`、`renounceOwnership()`。这是标准管理接口；放弃所有权不可逆，池仍可存赎，但无人可初始化/暂停/恢复，故部署流程不得调用 renounceOwnership。转移所有权不会改变凭证绑定。

## 事件：与实际 ABI 一致

```solidity
event Initialized(address indexed assetToken, address indexed shareToken);
event Deposited(address indexed user, uint256 assets, uint256 shares);
event Redeemed(address indexed user, uint256 shares, uint256 assets);
event Paused(address account);   // OZ 5.0.2: account 不是 indexed
event Unpaused(address account); // OZ 5.0.2: account 不是 indexed
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
event Transfer(address indexed from, address indexed to, uint256 value);
event Approval(address indexed owner, address indexed spender, uint256 value);
```

原 Foundry `PoolAsserts.sol` 将 Paused/Unpaused 的 account 标为 indexed，与 OZ 不一致，C 迁移时必须修正。本次未改该原文件。

## 错误与回滚条件

SecurePool 自定义无参数错误：

| 错误 | 条件 |
|---|---|
| AlreadyInitialized() | owner 第二次初始化 |
| NotInitialized() | 初始化之前存赎 |
| InvalidToken() | 初始化地址相同、零地址或无代码 |
| InvalidShareToken() | 凭证绑定其他池或供应非零 |
| UnsupportedDecimals() | 资产/凭证 decimals !=18 |
| ZeroAmount() | 存赎数量为零 |
| InsufficientShares() | 调用者凭证不足 |
| InsufficientPoolAssets() | 实际资产小于请求赎回量 |
| InsufficientBacking() | 实际资产小于全部凭证供应；拒绝继续存赎 |
| UnsupportedAssetTransfer() | 池与用户实际余额变化不等于请求量 |

PoolShareToken：`InvalidPool()`（绑定零地址/EOA），`OnlyPool()`（mint/burn 调用者不是池）。

继承/库错误：`OwnableUnauthorizedAccount(address account)`、`OwnableInvalidOwner(address owner)`、`EnforcedPause()`、`ExpectedPause()`、`ReentrancyGuardReentrantCall()`、`SafeERC20FailedOperation(address token)`；ERC20 包括 `ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)`、`ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)`、`ERC20InvalidSender(address sender)`、`ERC20InvalidReceiver(address receiver)`、`ERC20InvalidApprover(address approver)`、`ERC20InvalidSpender(address spender)`。算术边界仍受 Solidity panic 检查。缺少必要 getter 的非兼容合约可能直接从外部调用/ABI 解码处回滚，不保证统一为 InvalidToken。

检查顺序：initialize 先 onlyOwner 再 AlreadyInitialized；存赎先 initialized、paused、重入锁，再数量及余额。一个输入违反多个条件时，只保证先命中的错误。

## VulnerablePool 专用差异（仅本地）

同样无参构造、两地址 initialize、无返回值存赎、相同事件顺序；有 `cachedPoolBalance() returns(uint256)`。构造与初始化/存赎限定 chainId=31337，违反报 `LocalOnly()`。这不是对网络身份的密码学证明；私有链可使用相同 chainId，必须结合脚本限制。

initialize 故意允许任意人重复调用并重置缓存，仍检查代码与 share.pool 关联；deposit 的错误缓存减法与 redeem 的实际余额比例计算见 B-contracts-guide。仅用于局部教学，绝不可把其结果用于安全池预期断言。

ABI：`artifacts/contracts/<Name>.sol/<Name>.json` 的 `abi` 字段；由实际编译生成。不要手写或使用旧 Foundry 假定的 ABI。
