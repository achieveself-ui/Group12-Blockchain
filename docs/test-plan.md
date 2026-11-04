# DeFi Shield 测试计划（test-plan.md）

**项目**：DeFi Shield —— DeFi 流动性池安全演示系统（复现并防护 Yearn yETH "16 Wei" 类异常铸币攻击的教学原型）
**测试对象**：`contracts/TestToken.sol`、`contracts/PoolShareToken.sol`、`contracts/SecurePool.sol`（修复版）、`contracts/VulnerablePool.sol`（漏洞教学版，仅本地）
**依据文件**：《DeFi Shield 项目统一说明 v2.0》（组长 A 发布）——本文所有接口名、函数签名、事件字段、技术选型均以其第 4 节「固定接口规范」为准
**编写人**：C（测试与安全分析负责人）
**版本**：v2.0（对齐组长统一说明；替代此前基于 Foundry / 比例定价假设的 v1.0 草案）
**日期**：2026-11-04

---

## 1. 背景与测试目标

### 1.1 漏洞背景（依据 Yearn 官方披露 2025-12-01）

2025 年 11 月 30 日，Yearn yETH 加权稳定兑换池在以太坊主网遭攻击，损失约 900 万美元。攻击链要点：

1. 攻击者用极端不平衡的存款让内部数学计算进入无效状态（关键乘积项变为 0），合约未拒绝异常结果，铸出远超存入资产价值的凭证；
2. 用过量凭证反复抽走池内真实资产；
3. 池子被抽空后，**重新进入本应只在首次启动时使用的初始化流程**，配合不安全减法（下溢绕回极大值）产生天文数量凭证，继续抽取资产。

本项目的 `VulnerablePool.sol` 以**受控、可复现的教学缺陷**模拟上述机理（不复制真实攻击的完整资金提取链）：采用比例定价 + 缓存余额记账——池子被清空、凭证总量归零后缓存余额残留，此时仅存入 16 wei 即可铸出约 2.35×10²³ 枚凭证并提取超额资产；且初始化可重复进入。`SecurePool.sol` 为修复版，按组长文件采用 **1:1 教学规则**。

### 1.2 定价模型（两版不同，测试断言依据）

| 版本 | 存款铸凭证 | 赎回取资产 | 依据 |
|---|---|---|---|
| **SecurePool（修复版）** | **1:1**：存入 `assets` 铸出等量凭证（最小单位）；`assets > 0` | **1:1**：销毁 `shares` 取回等量资产；需用户余额与池内资产充足 | 统一说明 4.1 / 4.3 固定规则 |
| **VulnerablePool（教学版）** | 首次 `shares = assets`；后续 `shares = assets × totalSupply / cachedPoolBalance`（使用**缓存余额**而非实时余额） | `assets = shares × cachedPoolBalance / totalSupply` | 本测试计划与 B 约定的受控教学缺陷（统一说明 4.3 允许） |

**推论**：SecurePool 为 1:1，任意成功存款铸出的凭证恒等于转入资产，不存在"天量铸币"的数学路径，故无需死份额/铸币比例熔断；其防护点为——输入与边界检查（0 值、溢出）、赎回条件检查（用户余额 + 池内资产）、一次性初始化、凭证铸币/销毁权限仅限池合约、管理员暂停机制（统一说明功能 3）。

### 1.3 测试目标

| 目标 | 说明 |
|---|---|
| 功能正确性 | 1:1 存款/赎回路径完全符合固定规则，事件字段正确 |
| 健壮性 | 异常输入（零数量、超额、未授权、溢出）被正确拒绝且无状态变化 |
| 权限控制 | pause/unpause 仅管理员；initialize 仅一次；凭证 mint/burn 仅池合约可调 |
| 漏洞可复现 | 教学版上完整复现 16-wei 攻击与重复初始化攻击（受控边界内） |
| 防护有效性 | 修复版在**完全等价的攻击输入**下不沦陷（1:1 恒等约束成立） |
| 不变量保持 | 任意操作序列后，核心会计不变量成立（修复版）或按预期被违反（教学版，作为漏洞证据） |
| 静态分析 | Slither 扫描无未处理的 Critical/High 问题（环境不支持时记录原因与替代检查） |

---

## 2. 固定接口速查（摘自统一说明 4.1 / 4.2，测试断言一律以此为准）

```text
TestToken.sol        mint(address to, uint256 amount)          // 测试资产，仅所有者/授权者可铸造
PoolShareToken.sol   totalSupply() / balanceOf(address)         // ERC-20 标准查询
PoolShareToken.sol   mint(address to, uint256 amount)           // 仅资金池合约有权调用
PoolShareToken.sol   burn(address from, uint256 amount)        // 仅资金池合约有权调用
SecurePool.sol       deposit(uint256 assets)                    // 存入资产，1:1 铸等量凭证；assets > 0
SecurePool.sol       redeem(uint256 shares)                     // 赎回凭证，1:1 取回资产；shares > 0
SecurePool.sol       getPoolBalance() returns (uint256)         // 池内实际测试资产余额
SecurePool.sol       shareToken() returns (address)             // 凭证代币合约地址
SecurePool.sol       initialized() returns (bool)               // 是否完成初始化（仅一次）
SecurePool.sol       paused() returns (bool)                    // 是否暂停
SecurePool.sol       pause() / unpause()                        // 仅管理员（OpenZeppelin Ownable）
SecurePool.sol       owner() returns (address)                  // 管理员地址（Ownable）
初始化函数（部署流程调用）  initialize(address assetToken, address shareToken)

事件：
Deposited(user, assets, shares)   Redeemed(user, shares, assets)
Paused(account)                   Unpaused(account)
```

固定规则（统一说明 4.3）：
- 所有数量为 uint256 最小单位（前端展示才按 decimals 转换）；
- `paused() == true` 时 `deposit` / `redeem` 必须回滚，**查询函数仍可正常调用**；
- 初始化只允许成功一次，成功后 `initialized() == true`，再次调用必须回滚；
- 只有资金池合约能调用凭证 mint/burn，普通用户不能直接铸造凭证；
- VulnerablePool 仅本地测试，禁止部署到公共测试网/主网；只允许部署 SecurePool 到 Sepolia。

---

## 3. 测试环境

| 项目 | 配置 |
|---|---|
| 开发框架 | **Hardhat + JavaScript**（统一说明第 3 节：全组统一，不混用 Foundry 作为主框架） |
| 合约语言 | Solidity（0.8.x，启用内置溢出/下溢检查） |
| 安全库 | OpenZeppelin Contracts（ERC-20、Ownable/AccessControl、Pausable） |
| 测试工具 | Mocha + Chai + `@nomicfoundation/hardhat-toolbox`（ethers.js + chai-matchers） |
| 覆盖率工具 | `solidity-coverage`（`npx hardhat coverage`） |
| 静态分析 | Slither（环境不支持时记录原因并做替代人工检查） |
| 网络 | 漏洞演示仅在 Hardhat 本地网络；修复版可另测 Sepolia 部署（E 负责，C 只验证本地行为一致性） |
| 运行环境 | Node.js LTS（具体版本由 E 在 README 固定） |

### 3.1 测试文件与仓库结构（统一说明第 5 节固定）

```
defi-shield/
├── contracts/
│   ├── TestToken.sol
│   ├── PoolShareToken.sol
│   ├── SecurePool.sol
│   └── VulnerablePool.sol      # 仅本地教学测试
├── test/                       # 负责人 C
│   ├── deposit-redeem.test.js      # 正常路径 + 异常输入（NP / EX）
│   ├── secure-pool.test.js         # 权限与状态 + 防护对比（PM / SEC）
│   ├── vulnerable-demo.test.js     # 漏洞演示 PoC（VUL）
│   └── security-regression.test.js # 不变量 + 回归套件（INV / REG）
├── scripts/                    # deploy-local.js / deploy-sepolia.js / setup-demo.js（E）
├── docs/                       # 本文件 test-plan.md、api-spec.md、security-report.md
└── artifacts/                  # 测试输出、覆盖率、静态扫描报告（不放密钥）
```

### 3.2 常用命令（写入 README，保证任何人可复现）

```bash
npm install                      # 安装依赖
npx hardhat compile              # 编译全部合约
npx hardhat test                 # 运行全部测试
npx hardhat test test/secure-pool.test.js      # 只跑单个文件
npx hardhat test --grep "16-wei"               # 按名称筛选用例
npx hardhat coverage             # 行覆盖率报告（solidity-coverage）
slither contracts/               # 静态分析（不可用时记录原因与替代检查）
```

### 3.3 测试账户约定（各测试文件 setUp 统一）

| 角色 | 用途 |
|---|---|
| `admin` | 部署者/管理员，调用 initialize / pause / unpause |
| `alice` / `bob` / `carol` | 正常用户：TestToken mint + approve + deposit/redeem |
| `attacker` | 攻击者（仅出现在 VUL / SEC 场景） |
| `victim` | 提供真实流动性的受害用户（VUL-01 中在池清空后注入资产） |

---

## 4. 优先级定义

| 优先级 | 含义 |
|---|---|
| **P0** | 资金正确性与核心安全场景，任何失败即阻塞交付 |
| **P1** | 重要功能与权限场景，失败需修复后方可交付 |
| **P2** | 边界与健壮性场景，失败记录缺陷并排期修复 |

---

## 5. 测试场景

> **必查数据**缩写：
> **UB** = 用户 TestToken 余额（`token.balanceOf(user)`）
> **US** = 用户凭证余额（`PoolShareToken.balanceOf(user)`）
> **PA** = 池内实际资产（`getPoolBalance()`，并与 `token.balanceOf(pool)` 交叉核对）
> **TS** = 凭证总供应量（`PoolShareToken.totalSupply()`）
> **CB** = 缓存余额（仅 VulnerablePool 有；B 需暴露只读 getter 供测试断言）
> **EV** = 事件日志（Deposited / Redeemed / Paused / Unpaused）
> 统一要求（C 职责，统一说明第 6 节）：每条场景必须检查**交易前后**的 UB / US / PA / TS / EV，不能只看交易是否报错。

### 5.1 正常路径（NP → test/deposit-redeem.test.js，对 SecurePool）

| 场景 ID | 优先级 | 前置条件 | 操作步骤 | 预期结果 | 必查数据 |
|---|---|---|---|---|---|
| NP-01 首次存款 1:1 铸凭证 | P0 | SecurePool 已 initialize；alice 持有 ≥1000 token 且已 approve 池合约 | 1. alice `deposit(1000)` | 交易成功；按 1:1 规则铸出 **1000** 凭证；触发 `Deposited(alice, 1000, 1000)` | UB(alice) −1000；US(alice) = 1000；PA = 1000；TS = 1000；EV 字段正确 |
| NP-02 后续存款仍按 1:1 | P0 | NP-01 完成；bob 持有 token 且已 approve | 1. bob `deposit(500)` | 1:1 规则不随池状态改变：铸出 **500** 凭证（不是按比例公式） | UB(bob) −500；US(bob) = 500；PA = 1500；TS = 1500；EV `Deposited(bob, 500, 500)` |
| NP-03 正常赎回 1:1 | P0 | NP-02 完成；alice 持有 1000 凭证 | 1. alice `redeem(500)` | 销毁 500 凭证，取回 **500** TestToken；触发 `Redeemed(alice, 500, 500)` | UB(alice) +500；US(alice) = 500；PA = 1000；TS = 1000 |
| NP-04 存款后立即赎回零损耗 | P0 | 池内已有流动性；carol 持有 token 且已 approve | 1. carol `deposit(1000)`；2. 立即 `redeem(1000)` | 1:1 规则下**精确无损**：拿回资产 = 存入资产（精确到 wei，不允许任何精度损耗）；池状态完全复原 | UB(carol) 存赎前后完全一致；US(carol) = 0；PA / TS 回到存款前原值（精确相等）；两条 EV 齐全 |

> 说明：1:1 模型无整数除法，故精度损耗上限为 **0 wei**（v1.0 草案中"允许 1 wei 损耗"的规则随比例定价一并作废）。任何不等式即记 Critical 缺陷。

### 5.2 异常输入（EX → test/deposit-redeem.test.js）

| 场景 ID | 优先级 | 前置条件 | 操作步骤 | 预期结果 | 必查数据 |
|---|---|---|---|---|---|
| EX-01 零数量存款 | P1 | alice 已 approve | 1. alice `deposit(0)` | **revert**（统一说明 4.1：amount 必须大于 0）；无任何状态变化 | UB/US/PA/TS 全部不变；无 Deposited 事件 |
| EX-02 零数量赎回 | P1 | alice 持有 >0 凭证 | 1. alice `redeem(0)` | **revert**（shares 必须大于 0）；无状态变化 | UB/US/PA/TS 不变；无 Redeemed 事件 |
| EX-03 赎回超过自身凭证余额 | P1 | alice 仅持有 500 凭证 | 1. alice `redeem(1000)` | **revert**（ERC-20 余额不足或池合约先检查）；无状态变化 | US(alice) 仍为 500；PA/TS 不变 |
| EX-04 赎回所需资产超过池内资产 | P1 | 构造 PA < 可赎回资产的状态（构造方式与 B 对齐：用 `hardhat_setStorageAt` 下调池内资产，或由 TestToken 直接转移造成账实错位） | 1. 持有足额凭证的用户 `redeem(shares)` 使应付资产 > PA | **revert**（统一说明 4.1：池内资产必须足够）；不得出现"凭证已销毁但资产未付出"的半更新状态 | TS 与 PA 同步变化或完全不变（原子性）；无 Redeemed 事件 |
| EX-05 缺少 approve 授权 | P1 | dave 持有 TestToken 但未 approve 池合约 | 1. dave `deposit(100)` | **revert**（`transferFrom` allowance 不足）；池状态不变 | UB(dave)/PA/TS 不变；无 Deposited 事件 |

### 5.3 权限与状态（PM → test/secure-pool.test.js）

| 场景 ID | 优先级 | 前置条件 | 操作步骤 | 预期结果 | 必查数据 |
|---|---|---|---|---|---|
| PM-01 非管理员调用 pause/unpause | P0 | eve 为非管理员地址 | 1. eve 调 `pause()`；2. eve 调 `unpause()` | 两次均 **revert**（OpenZeppelin Ownable：`OwnableUnauthorizedAccount`）；池状态不变 | `paused()` 恒为 false；无 Paused/Unpaused 事件 |
| PM-02 暂停期间存赎被拒、查询正常、恢复后正常 | P0 | admin 已部署并 initialize；池内有 alice 流动性 | 1. admin `pause()`；2. alice `deposit(100)` → 应 revert；3. alice `redeem(100)` → 应 revert；4. 依次调用 `getPoolBalance()` / `shareToken()` / `initialized()` / `paused()` / `owner()`；5. admin `unpause()`；6. alice 重新存赎 | 步骤 2/3 revert；**步骤 4 全部查询正常返回**（统一说明 4.3 固定规则）；步骤 6 成功且 1:1 正确；`Paused(admin)` / `Unpaused(admin)` 事件各一次 | 暂停期间 UB/US/PA/TS 完全不变；EV 断言 account 字段为 admin |
| PM-03 初始化仅一次 | P0 | SecurePool 已完成首次 `initialize(assetToken, shareToken)` | 1. 断言 `initialized() == true`、`shareToken()` 正确；2. admin 再次 `initialize(...)`；3. eve 调 `initialize(...)` | 步骤 2/3 均 **revert**（再次调用必须回滚）；初始化参数不被覆盖 | `initialized()` 恒 true；`shareToken()` 地址不变 |
| PM-04 普通用户直接铸造/销毁凭证 | P0 | eve 为非池合约地址 | 1. eve 直接调用 `PoolShareToken.mint(eve, 1e24)`；2. eve 直接调用 `PoolShareToken.burn(alice, 1)` | 两次均 **revert**（统一说明 4.3：仅资金池合约有权调用）；凭证供应不受影响 | TS/US 不变；无任何事件 |
| PM-05 TestToken 铸造权限 | P1 | eve 为非所有者/授权者 | 1. eve 调 `TestToken.mint(eve, 1e24)` | **revert**（仅所有者/授权者可铸造测试代币） | eve 的 UB 不变 |

### 5.4 漏洞演示（VUL → test/vulnerable-demo.test.js，对 VulnerablePool，**预期攻击成功 = 漏洞存在性证据**）

> 受控边界（统一说明 4.3 / 功能 2）：教学缺陷只演示到"异常凭证被铸造并可提取超额资产"，以池内真实资产为上限，不复制真实攻击的完整资金提取链。每个 PoC 必须可重复运行、断言精确。

| 场景 ID | 优先级 | 前置条件 | 操作步骤 | 预期结果（攻击成功路径） | 必查数据 |
|---|---|---|---|---|---|
| VUL-01 16-wei 攻击完整复现 | P0 | VulnerablePool 已部署（本地网络）；attacker 持有适量 TestToken；victim 持有 10_000 token | 1. attacker `deposit(D)` 首次存款；2. attacker `redeem(全部凭证)` 清空池子 → 断言 `TS == 0` 但 **CB 残留 > 0**（缓存未清零的失同步状态）；3. victim `deposit(10_000)` 注入真实资产；4. attacker `deposit(16)`（16 wei）→ 比例公式引用残留 CB，铸出**天量凭证**（目标量级 ≥ 10²⁰，对标真实事件 2.35×10²³）；5. attacker `redeem(全部所得凭证)` 抽走超额资产 | 每步符合攻击预期：步骤 2 后 `TS == 0 且 CB > 0`（核心失同步断言）；步骤 4 所得凭证 ≫ 16；步骤 5 attacker 净获利 > 0（UB 增量远超 16 wei），池内资产被超额抽走（受控上限：池内真实资产总额） | 每步记录 UB(attacker) / US(attacker) / PA / **TS** / **CB**；Deposited/Redeemed 事件完整；输出攻击前后对比数据（功能 4 素材） |
| VUL-02 重复初始化攻击 | P1 | VulnerablePool 的 initialize 无一次性保护；池已初始化并运行 | 1. 任意地址再次调用 `initialize(...)` 传入恶意参数 | 调用**成功**（缺陷存在性证据）；初始化状态被覆盖（如篡改资产/凭证地址），攻击者可借此重置内部记账 | 参数篡改前后对比；初始化状态变化记录 |

### 5.5 防护对比（SEC → test/secure-pool.test.js，对 SecurePool，输入与 PoC **完全等价**）

| 场景 ID | 优先级 | 前置条件 | 操作步骤 | 预期结果（防护生效） | 必查数据 |
|---|---|---|---|---|---|
| SEC-01 等价清空+微额存款序列不再铸出天量凭证 | P0 | SecurePool 已 initialize；执行与 VUL-01 **完全相同**的调用序列（同参数、同顺序） | 1. attacker `deposit(D)`；2. attacker `redeem(全部)`；3. victim `deposit(10_000)`；4. attacker `deposit(16)` | 1:1 规则与实时余额使失同步无从发生：步骤 4 只铸出 **16** 凭证；`Deposited(attacker, 16, 16)`；绝不出现 10²⁰ 量级 | 步骤 2 后 TS/PA 同步归零（SecurePool 无缓存层）；步骤 4 后 US(attacker) = 16、TS = 10_016；全程 PA ≥ TS |
| SEC-02 等价攻击赎回无法获得超额资产 | P0 | SEC-01 完成 | 1. attacker `redeem(16)` | 取回**恰好 16** TestToken；净收益为 0；victim 资产不受影响 | UB(attacker) 净变化 0；US(attacker) = 0；PA = 10_000；`Redeemed(attacker, 16, 16)` |
| SEC-03 铸币硬约束（替代比例熔断） | P0 | SecurePool 已 initialize | 1. 对多组金额（含极端值：1 wei、type(uint256).max、0）断言 deposit 行为；2. 任意成功存款后断言铸出凭证 == 存入资产 | 1:1 恒等式成立：每次成功 `deposit(a)` 铸出凭证恰为 `a`；`deposit(0)` revert；超大金额因余额/转移不足 revert；不存在任何输入使铸出凭证 > 存入资产 | 每组断言 `Deposited(user, a, a)` 且 TS 增量 == PA 增量 |
| SEC-04 重复初始化被拒（等价输入） | P0 | 同 PM-03；输入与 VUL-02 等价 | 1. 以 VUL-02 相同参数与调用者再次 `initialize(...)` | **revert**；与 VUL-02 形成对照 | `initialized()` 恒 true；参数不变 |

### 5.6 不变量清单（INV → test/security-regression.test.js）

Hardhat/Mocha 无原生模糊测试器，采用**脚本化随机循环**实现同等效果：随机 `amount ∈ [1, 10²⁴]`、随机操作序列（deposit / redeem / pause / unpause / 换用户），每轮操作后检查全部不变量，至少 **1000 轮**（轮数写入常量，可调）。

| 不变量 ID | 优先级 | 不变量陈述 | 验证方式与预期 |
|---|---|---|---|
| INV-01 | P0 | `PoolShareToken.totalSupply() == Σ balanceOf(所有已知账户)`（含 admin、测试用户、任何持有者） | 每步操作后遍历求和断言；两版均须成立 |
| INV-02 | P0 | SecurePool：`getPoolBalance() ≥ totalSupply()`——1:1 下每枚凭证至少有 1 单位资产背书（直接向池捐赠资产只会使左边更大，不破坏不等式） | 每步断言；SecurePool 恒成立 |
| INV-03 | P1 | VulnerablePool：缓存余额 CB == 池内真实余额 PA（账实一致） | 正常序列下应成立；**在 VUL-01 步骤 2 之后预期被违反**——违反时刻即为漏洞证据，测试中作为"预期违反"断言记录并输出到安全报告 |
| INV-04 | P0 | "存款后立即赎回全部所得凭证"零损耗：池内资产与用户资产完全复原 | 随机 amount 循环 ≥1000 次，断言 UB/PA/TS 精确相等（1:1 无精度损耗） |
| INV-05（SecurePool） | P0 | 每次成功 deposit / redeem 后，`ΔtotalSupply == ΔgetPoolBalance()`（铸/销毁凭证与资产进出严格一一对应） | 每步前后差值断言；任何不等即 Critical 缺陷 |

---

## 6. 通过标准

| 标准 | 要求 |
|---|---|
| 场景通过率 | **P0、P1 场景 100% 通过**；P2 允许存在已记录并排期的已知缺陷 |
| PoC 有效性 | VUL-01 / VUL-02 在教学版按预期复现（这是漏洞存在性证据，不是测试失败）；PoC 可重复运行、断言精确、仅在本地网络执行 |
| 防护等价性 | 与 PoC **完全相同的输入序列**在 SecurePool 上全部 revert 或仅产生 1:1 合理结果（SEC-01 ~ SEC-04 通过）；攻击前后对比数据（功能 4）来自实际运行结果 |
| 不变量 | INV-01 ~ INV-05 在 ≥1000 轮随机操作下零违反（INV-03 仅允许在 VUL-01 规定的预期违反点被打破） |
| 代码覆盖率 | `npx hardhat coverage` **行覆盖率 ≥ 85%**、分支覆盖率 ≥ 75%；安全关键函数（deposit / redeem / initialize / pause / unpause / PoolShareToken.mint / burn）行覆盖 100% |
| 静态分析 | Slither 无未处理的 Critical/High 问题（Medium/Low 记录处理状态；环境不支持时记录原因与替代人工检查） |
| 可复现性 | 全部结果通过统一命令（3.2 节）复现；测试输出、覆盖率与扫描报告存入 `artifacts/` |
| 状态检查纪律 | 每条场景均检查交易前后 UB/US/PA/TS/EV（统一说明第 6 节 C 职责），禁止只看交易是否报错 |

---

## 7. 缺陷管理流程

```
发现 → 记录 → 通知开发（B）→ 修复 → 回归 → 关闭
```

1. **发现**：测试执行 / 随机循环 / 静态扫描 / 代码评审中发现行为与预期不符。不变量被意外打破、PoC 输入在修复版上意外成功，均为**最高严重级**，立即按统一说明第 9 节**暂停相关合并与演示**。
2. **记录**：登记到问题清单（Issue），必填字段：
   - 缺陷 ID / 标题 / 严重级（Critical / High / Medium / Low）
   - 关联场景 ID（如 SEC-01）与测试文件、用例名
   - 复现命令（`npx hardhat test test/xxx.test.js --grep "用例名"`）与最小复现步骤
   - 实际结果 vs 预期结果（附关键断言输出 / 日志）
   - 环境信息（Node.js / Hardhat 版本、commit hash）
3. **通知开发**：指派给合约开发负责人 B；Critical / High 当日响应。**涉及公共接口的改动必须由 A 审核批准**（统一说明第 9 节），任何人不得只改自己部分。
4. **修复**：B 在 `feature/B-xxx` 分支修复，提交信息注明缺陷 ID（如 `fix: reject zero-amount deposit, closes #12`）；修复须附"修复前失败、修复后通过"的测试证据。
5. **回归**：C 运行**关联场景 + 全部 P0 场景 + 完整 security-regression 套件**；失败时提供最小复现步骤和日志（C 职责）。
6. **关闭**：回归通过后关闭缺陷，更新 security-report.md 与问题清单；每次合并后同步更新 README/docs，避免文档与代码不一致。

### 缺陷严重级参考

| 严重级 | 判定标准 | 示例 |
|---|---|---|
| Critical | 可导致资金损失或修复版防护被绕过 | 16-wei 等价输入在 SecurePool 仍铸出超额凭证；存赎不等（1:1 破坏） |
| High | 核心功能错误或权限失效 | 非管理员可 pause；普通用户可直接 mint 凭证 |
| Medium | 边界行为不符 | 暂停期间查询函数不可用（违反 4.3 固定规则）；事件字段错序 |
| Low | 不影响资金与权限的问题 | 错误提示不准确；命名与 api-spec.md 不一致 |

---

## 8. 交付物清单（统一说明第 6 节 C 的交付物）

| 交付物 | 位置 |
|---|---|
| 本测试计划 | `docs/test-plan.md` |
| 测试文件（按功能分开，统一说明 5.1） | `test/deposit-redeem.test.js`、`test/secure-pool.test.js`、`test/vulnerable-demo.test.js`、`test/security-regression.test.js` |
| 实际测试输出（每次关键运行的日志） | `artifacts/` |
| 覆盖率报告 | `artifacts/`（`npx hardhat coverage` 输出） |
| 静态扫描报告（Slither 或替代检查记录） | `artifacts/` + 摘要进 `docs/security-report.md` |
| 安全报告 | `docs/security-report.md`（哪些风险被发现、哪些检查通过） |
| 问题清单 + 回归测试记录 | `artifacts/`（或仓库 Issue 区） |

---

## 9. 与 v1.0 草案的差异说明（供组内同步）

| 变更点 | v1.0 草案 | v2.0（本文，对齐组长文件） |
|---|---|---|
| 测试框架 | Foundry（forge test / forge coverage） | **Hardhat + JavaScript**（统一说明第 3 节硬性规定） |
| 存赎接口 | `withdraw(uint256 shares)` | **`redeem(uint256 shares)`** |
| 初始化 | `initialize(address admin)` | **`initialize(address assetToken, address shareToken)`**，另设 `initialized()` 查询 |
| 事件 | `Deposit` / `Withdraw` | **`Deposited(user, assets, shares)` / `Redeemed(user, shares, assets)`**（Paused/Unpaused 不变） |
| 定价模型 | 两版均比例定价 | **SecurePool 固定 1:1**；比例定价+缓存残留降级为 VulnerablePool 的受控教学缺陷 |
| 存后立赎精度损耗 | 允许 ≤1 wei | **0 损耗**（1:1 无除法） |
| 死份额 / 铸币比例熔断 | SecurePool 防护项 | 1:1 模型下无天量铸币路径，改为 **1:1 铸币恒等断言（SEC-03）**，死份额不再需要 |
| 新增场景 | — | PM-04/05（凭证与 TestToken 铸造权限）、PM-02 步骤 4（暂停期间查询可用）、PA 交叉核对 `getPoolBalance()` vs `token.balanceOf(pool)` |

---

*本计划在 B 完成合约代码前产出（测试先行）。若 B 实现的内部缺陷机理（VulnerablePool 缓存字段名、构造方式）与本文假设有出入，以 `docs/api-spec.md` 与代码为准，由 A 冻结接口版本后同步更新本文并通知全组。*
