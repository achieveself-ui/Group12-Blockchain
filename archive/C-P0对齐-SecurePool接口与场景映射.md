# C 角色 · P0 开工对齐输出（基于《DeFi Shield 项目统一说明 v2.0》）

> **状态：已归档（不建议作为交付物提交）**
> 本文是开工阶段的过程稿，其中接口表、场景 ID、Q1–Q21 问题清单已全部并入 `docs/test-plan.md`。
> 保留目的：留痕"问题清单是在写测试之前提出的"，答辩被问"你们的疑问有没有记录"时可指向此文件。

> 角色：C（测试与安全分析）
> 基准：Solidity + Hardhat + JavaScript（ethers.js）唯一主框架；固定 1:1 铸币；VulnerablePool 仅本地链，SecurePool 才可上 Sepolia。
> 信息边界声明：本文所依据的是 `DeFi Shield_C角色测试与安全分析_提示词包v2.md` 中的「基准速查卡」与「交付物/红线」条款，未见 A 发布的统一说明原文。凡速查卡未写明的细节，一律列入第 4 节问题清单，由 A 裁定，C 不自行决定。

---

## 1. yETH 事件的问题链（5 句话）与简化模型映射

1. **计算越界**：池子处于 `totalSupply == 0` 但缓存的虚拟余额（`packed_vbs[]`）仍残留旧值的边界状态下，首次存款的份额换算按残留值取基准，除/乘关系整体越界，得到数量级完全失真的结果。
2. **关键值异常**：16 wei 的存入被换算成约 2.35×10²³ 枚 yETH，关键中间量（份额）在一步计算里就失去业务含义。
3. **状态不一致**：会计状态（缓存虚拟余额）与真实状态（池内实际代币余额、`totalSupply`）长期失同步，且没有任何不变量在每次状态变更后校验二者一致。
4. **初始化可重入**：攻击者把池子"清空"回初始化态后，本应只执行一次的初始化入口被再次使用，关键参数/状态被重置，防护链断开。
5. **不安全的减法**：余额记账依赖未做前置条件校验的减法（余额 − 提取额），在状态已错乱时被绕过或下溢，把账面错误放大成池内真实资产被抽走（约 900 万美元）。

### 映射到我们的简化模型

| 链条环节 | 简化模型是否对应 | 说明 |
|---|---|---|
| (1) 计算越界 | ✅ 强对应 | VulnerablePool 的"按失同步的缓存值换算份额"就是该环节的直接简化 |
| (2) 关键值异常 | ✅ 强对应 | 微额存款铸出远超存入量的凭证，即 v2 的"异常铸币"演示点 |
| (3) 状态不一致 | ✅ 强对应 | `getPoolBalance()` 与池内真实代币余额出现偏差，即 v2 的"状态失同步"演示点 |
| (4) 初始化可重入 | ✅ 对应 | 池被抽空后二次 `initialize` 仍成功 |
| (5) 不安全的减法 | ⚠️ 部分对应 | Solidity 0.8+ 默认 checked arithmetic，真实 uint256 下溢会直接 panic revert，因此模型里只能表现为"缺少前置条件校验的减法/换算"，强度弱于真实事件。**该项的落地方式需 A/B 确认（见 Q17）** |

> 一句话：我们用 (1)(2)(3) 打包成"异常铸币"，用 (4) 做"重复初始化"，(5) 只能做形式对应——这一点在 security-report 里必须如实写，不能声称"完整复现了五点"。

---

## 2. SecurePool 固定接口与固定事件：成功条件 / 回滚条件

### 2.1 固定事件（不得增删、不得改名）

```solidity
event Deposited(address user, uint256 assets, uint256 shares);
event Redeemed(address user, uint256 shares, uint256 assets);
event Paused(address account);
event Unpaused(address account);
```

- 字段顺序固定：`Deposited` 是 (user, assets, shares)，`Redeemed` 是 (user, shares, assets)——两者参数顺序不同，断言时不可照抄。
- 1:1 规则下 `Deposited` 的 `assets` 与 `shares` 数值必然相等；若不等即为缺陷（这是最便宜的一条异常铸币探针）。
- 是否 `indexed`：**待 A 定稿（Q1）**，C 不猜。

### 2.2 状态查询（view，任何状态下都必须可调用）

| 函数 | 成功条件 | 必须回滚的条件 | 备注 |
|---|---|---|---|
| `getPoolBalance() → uint256` | 恒可调用，含 `paused == true` 期间 | 无 | 取值口径（实时读 `balanceOf` 还是内部记账）待确认（Q13） |
| `shareToken() → address` | 恒可调用 | 无 | 未初始化时返回什么待确认（Q5） |
| `initialized() → bool` | 恒可调用 | 无 | 只允许 `false → true` 单向 |
| `paused() → bool` | 恒可调用 | 无 | 与 OZ Pausable 语义是否一致待确认 |
| `owner() → address` | 恒可调用 | 无 | owner 来源待确认（Q7） |

> 说明：查询函数是"暂停时仍可用"这条规则的验证对象，`secure-pool.test.js` 的暂停用例必须显式调用它们，不能只断言写操作 revert。

### 2.3 业务函数

| 函数 | 成功条件（全部满足才成功） | 必须回滚的条件 | 成功后状态与事件 |
|---|---|---|---|
| `deposit(uint256 assets)` | ① 已初始化；② `paused == false`；③ `assets > 0`；④ 调用者资产代币余额 ≥ `assets`；⑤ 调用者对池子的 allowance ≥ `assets`；⑥ `transferFrom` 成功 | ① 未初始化；② 已暂停；③ `assets == 0`；④ allowance 不足；⑤ 余额不足；⑥ 代币转账失败/返回 false | 铸 `assets` 枚凭证给 `msg.sender`（严格 1:1）、`getPoolBalance` 增加 `assets`、`totalSupply` 增加 `assets`、emit `Deposited(msg.sender, assets, assets)` |
| `redeem(uint256 shares)` | ① 已初始化；② `paused == false`；③ `shares > 0`；④ 调用者凭证余额 ≥ `shares`；⑤ 池内资产 ≥ `shares`（1:1 下即 `getPoolBalance() ≥ shares`）；⑥ `burn` 与转账均成功 | ① 未初始化；② 已暂停；③ `shares == 0`；④ 凭证余额不足；⑤ 池内资产不足；⑥ 转账失败 | 销毁 `shares` 枚凭证、转出 `shares` 枚资产、`totalSupply` 与 `getPoolBalance` 同步减少、emit `Redeemed(msg.sender, shares, shares)` |

> 严禁"部分成功"：⑤ 不满足时必须整体回滚，不得出现"先 burn 一部分 / 先转一部分"的中间态。C 的断言方式是"回滚 + 全部状态与交易前逐项相等"，不是只看 revert。

### 2.4 生命周期与权限

| 函数 | 成功条件 | 必须回滚的条件 | 成功后状态与事件 |
|---|---|---|---|
| `initialize(address assetToken, address shareToken)` | ① 第一次调用（`initialized == false`）；② 参数有效性要求待 A 确认（Q9）；③ 调用者资格待确认（Q7） | ① 第二次及以后调用（**任意参数都必须回滚**，含参数完全相同的情况，Q8） | `initialized == true`、`shareToken` 与资产地址被记录、owner 设定方式待确认 |
| `pause()` | ① `msg.sender == owner()`；② 当前 `paused == false`（幂等性待确认 Q10） | ① 非 owner；② 已处于暂停态 | `paused == true`、emit `Paused(msg.sender)` |
| `unpause()` | ① `msg.sender == owner()`；② 当前 `paused == true` | ① 非 owner；② 未处于暂停态 | `paused == false`、emit `Unpaused(msg.sender)` |

### 2.5 PoolShareToken 的固定权限约束（虽不属 SecurePool 接口，但属 C 的验收范围）

| 操作 | 成功条件 | 必须回滚的条件 |
|---|---|---|
| `PoolShareToken.mint(...)` | 调用者是池合约 | 任何非池合约地址（含 owner、含部署者）调用 |
| `PoolShareToken.burn(...)` | 调用者是池合约 | 任何非池合约地址调用 |

- 断言方式：普通账户直调必须 revert，且 `totalSupply` 与相关余额在失败前后完全一致；只有经 `pool.deposit()` 才会增加供应量。
- 池合约地址如何在 PoolShareToken 侧被识别（构造时传入 / 一次性 setter）、错误名是什么：**待确认（Q19）**。

---

## 3. C 的交付物 / 不算完成的情况

### 3.1 交付物（6 项，路径固定）

| # | 交付物 | 路径 | 验收要点 |
|---|---|---|---|
| 1 | 4 个测试文件 | `test/deposit-redeem.test.js`、`test/vulnerable-demo.test.js`、`test/secure-pool.test.js`、`test/security-regression.test.js` | 文件名固定，不得新增第 5 个测试文件 |
| 2 | 测试计划 | `docs/test-plan.md` | 每场景含前置条件/操作/预期/必查数据/优先级 |
| 3 | 实际测试输出 | `artifacts/test-output-YYYY-MM-DD.log` | 必须用 `tee` 落盘，不能只截图 |
| 4 | 静态扫描报告 | `artifacts/slither-report.json` + `docs/static-analysis-report.md` | 若 A 允许合并则作为 security-report 一章 |
| 5 | 安全报告 | `docs/security-report.md` | 数字必须来自真实运行输出 |
| 6 | 问题清单 + 回归记录 | `docs/issue-log.md`、`docs/regression-log.md` | 若 A 要求合并，放 security-report 附录 |

### 3.2 明确"不算完成"（说明第 8 节，三条红线）

1. **只写测试方案不跑** → 不算完成。
2. **只贴截图、没有命令和日志** → 不算完成。
3. **把未运行的测试说成通过** → 不算完成。

### 3.3 由固定规则推导出的同类"不达标"情形（我的判读，需 A 确认是否入正式验收）

4. 断言用 `closeTo` / 容差代替严格相等——1:1 无舍入，任何偏差就是缺陷，用容差即视为漏测。
5. 只断言"交易 revert"，不检查"失败后状态未改变"。
6. 把 VulnerablePool 部署/运行到 Sepolia 或任何公共网络。
7. 为了让测试通过而改 B 的合约代码（C 对合约只读）。
8. 新增第 5 个测试文件、或修改公共接口/函数名/事件名来"迁就"测试。
9. 覆盖率低于目标（行覆盖 ≥ 85%）却未在 security-report 写明未覆盖项与原因。

---

## 4. 写测试前对 C 仍存在的歧义（问题清单，交 A 裁定，C 不自行决定）

> 格式：编号｜问题｜为什么阻塞测试｜需要 A 给出的结论形式

**接口与错误**

- **Q1**｜4 个事件的 `indexed` 标记（尤其 `Deposited.user`、`Redeemed.user`）如何定？→ 影响能否用 `queryFilter` 按地址过滤、以及日志字段读取方式。需 A 给：逐事件的 `indexed` 列表。
- **Q2**｜自定义错误全集与名称（如 `ZeroAmount` / `ZeroShares` / `InsufficientShares` / `InsufficientPoolAssets` / `AlreadyInitialized` / `NotOwner` / `NotPool`）？→ `revertedWithCustomError` 必须精确到错误名（及参数），猜错则测试必红。需 A 给：错误名 + 参数签名清单。
- **Q3**｜"池内资产不足"时抛什么？自定义错误，还是转账失败时冒泡 OZ 的 `ERC20InsufficientBalance`？→ 决定 SEC-04 用哪种断言。需 A 给：单一确定答案。
- **Q4**｜未 `approve` 就 `deposit` 的 revert 来源：ERC-20 的 `ERC20InsufficientAllowance`，还是池子在拉款前先自检并抛自定义错误？→ 两种错误签名互斥，测试只能写一种。需 A 给：确定的一种。
- **Q5**｜固定接口只列了 `shareToken()`，**没有 `assetToken()`**。是否存在资产地址的 getter？→ 若不存在，"二次 initialize 未改写资产地址"这条断言只能靠 `getPoolBalance` 间接推断。需 A 给：是否有 getter；若按"接口冻结"不加，则明确断言口径。
- **Q6**｜`deposit` / `redeem` 固定签名**无返回值**，那么"本次铸出多少份额"只能从事件或 `balanceOf` 差值取。若 B 想加 `returns (uint256)`，算不算改公共接口？→ 影响所有断言取值路径。需 A 给：保持无返回值 / 允许加返回值。

**生命周期与权限**

- **Q7**｜`owner()` 从哪来：构造函数 `Ownable(deployer)`，还是 `initialize` 的 `msg.sender`？若由 E 部署、A 初始化，owner 归谁？→ 直接决定 SEC-06/07 里"非 owner"用哪个账户。需 A 给：owner 设定时机与账户。
- **Q8**｜二次 `initialize` 在**参数完全相同**时是否也必须回滚？→ 有些实现只拦"参数不同"。需 A 给：明确"任意参数一律回滚"。
- **Q9**｜`initialize` 传零地址（`address(0)`）是否回滚？→ 决定要不要写这条用例。需 A 给：是否校验、错误名。
- **Q10**｜`pause()` 在已暂停时再调用、`unpause()` 在未暂停时再调用，是回滚还是幂等成功？→ 若跟随 OZ 默认则 revert（`EnforcedPause` / `ExpectedPause`），需 A 确认。需 A 给：两种情形的预期。
- **Q11**｜`paused == true` 时 `initialize` 是否也禁止？（速查卡只写 deposit/redeem 回滚）→ 影响暂停用例的边界。需 A 给：暂停的作用范围。

**经济模型与状态口径**

- **Q12**｜是否保留"死份额（dead shares）"机制？v2 是固定 1:1，若预铸死份额，则 `totalSupply == Σ 所有地址凭证余额` 里 `address(0)` 的余额是否计入、首存者拿到的凭证是否仍严格等于存入额？→ 这条**直接决定不变量 INV1 怎么写法**，是最关键的一问。需 A 给：有/无死份额 + 对应不变量表述。
- **Q13**｜`getPoolBalance()` 的口径：实时 `assetToken.balanceOf(address(this))`，还是内部记账变量？若有人直接 `transfer` 资产进出池子，两者会分叉。→ 决定 SEC-04"池内资产不足"怎么构造、以及 INV2 是否恒成立。需 A 给：确定口径 + 是否允许直接转账改变池内余额。
- **Q14**｜构造"池内资产不足"的允许手段：测试账户直接把池内资产转走（需池子无额外保护），还是"让另一用户先大额赎回"？→ 手法不同，对合约的隐含要求不同。需 A 给：指定一种为合法构造方式。
- **Q15**｜`redeem` 是否允许把池子赎回至零（`getPoolBalance == 0`、`totalSupply == 0`）？→ 若允许，则"零供应量边界"在 SecurePool 中是可达状态，测试必须覆盖；若禁止，需要错误名。需 A 给：允许/禁止。

**被测对象与版本**

- **Q16**｜VulnerablePool 与 SecurePool 是否**共用完全相同的接口与事件**？→ `security-regression.test.js` 要求"同一组输入喂两版"，签名不一致就无法做 1:1 对照，只能写两套调用。需 A 给：确认接口一致性。
- **Q17**｜VulnerablePool 的三类教学缺陷具体落在哪几处（异常铸币的触发前置条件、二次 `initialize` 的前提、所谓"不安全减法"是显式 `unchecked` 还是缺前置校验）？→ P4 的断言与"倍数"必须按真实缺陷写，不能按文档想象。需 A（或 B 的"教学缺陷说明"）给：缺陷点清单 + 预期现象。
- **Q18**｜`TestToken` 的 `decimals`（是否 18）、`owner` 是谁、mint 是否有上限？→ 影响夹具里 `10000e18` 的写法和余额精度。需 A 给：确定值。
- **Q19**｜`PoolShareToken` 构造参数（name / symbol / 初始 owner / 池地址如何注入）与 `mint`/`burn` 的访问控制形式（modifier 还是内联 if-revert）及错误名？→ 夹具部署顺序与 SEC-11 断言都依赖它。需 A 给：构造签名 + 错误名。
- **Q20**｜覆盖率目标 85% 的口径：行覆盖还是语句/分支覆盖？统计范围是否包含 VulnerablePool（教学版故意留洞，会拉低分支覆盖）？→ 影响是否要写 `/* coverage ignore */` 之外的说明。需 A 给：口径 + 统计范围。
- **Q21**｜`artifacts/` 是否已在 `.gitignore` 中被排除？→ 若被排除，日志进不了仓库，"用日志取证"这条就落不了地。需 A/E 给：确认目录可提交。

---

## 5. 测试文件与场景映射表（只能用固定的 4 个文件）

> 约束：断言辅助函数（`snapshotState` / `expectPoolState` / `expectBalancesUnchanged`）**内联在各自文件内**，不新增 `helpers/` 目录、不新增测试文件。

### 5.1 `test/deposit-redeem.test.js` —— 正常业务路径（SecurePool）

| 场景 ID | describe | 优先级 | 操作 | 关键断言 |
|---|---|---|---|---|
| DR-01 | 正常存款 | P0 | 首存 100 最小单位 | 用户凭证 = 100、`totalSupply` = 100、`getPoolBalance` = 100、池真实余额 = 100、用户资产 −100（全部 `equal`） |
| DR-02 | 正常存款 | P0 | 连续两次存款 | `totalSupply` == 两次之和；第二次不产生任何"额外"凭证 |
| DR-03 | 正常赎回 | P0 | 部分赎回 | 销毁凭证 == 取回资产 == shares；`totalSupply`/`getPoolBalance` 同步减 |
| DR-04 | 正常赎回 | P0 | 全额赎回 | 凭证归零、池归零、`totalSupply` 归零；取回总额严格等于存入总额 |
| DR-05 | 多用户 | P1 | A 存 300、B 存 200、A 赎 100 | 四方（A/B/池/供应量）数字全部对齐，B 余额不受影响 |
| DR-06 | 事件与状态一致性 | P0 | 每次成功存/赎 | `Deposited(user,assets,shares)`、`Redeemed(user,shares,assets)` 字段精确；1:1 下 assets == shares |
| DR-07 | 事件与状态一致性 | P0 | 任一操作后 | `expectPoolState`：`getPoolBalance` == 池真实余额 == `totalSupply` 三方恒等 |

### 5.2 `test/vulnerable-demo.test.js` —— 漏洞教学版（仅本地链；**通过 = 漏洞存在**）

| 场景 ID | describe | 优先级 | 操作 | 关键断言 |
|---|---|---|---|---|
| VUL-01 | 异常铸币演示 | P0 | 正常存款 | 先证明漏洞版正常时也是 1:1（对照基线） |
| VUL-02 | 异常铸币演示 | P0 | 构造异常状态后微额存款 | `sharesMinted > assetsDeposited * 10`（倍数按 B 的实现定，Q17），每步打印状态 |
| VUL-03 | 异常铸币演示 | P0 | 用异常凭证赎回 | 攻击者取回资产 > 投入；打印"投入 X / 取回 Y / 池剩 Z" |
| VUL-04 | 重复初始化 | P0 | 池清空后二次 `initialize` | 调用成功、`initialized()` 前后被改写，打印改前/改后 |
| VUL-05 | 状态失同步 | P1 | 抽空后读余额 | `getPoolBalance()` 与真实余额 `to.not.equal`，记录偏差数值 |
| VUL-06 | 环境守卫 | P2 | 文件级检查 | 断言运行网络为 hardhat 本地（防止误上公共网络） |

### 5.3 `test/secure-pool.test.js` —— 拒绝能力（每条都要"回滚 + 状态未变"双断言）

| 场景 ID | describe | 优先级 | 操作 | 关键断言 |
|---|---|---|---|---|
| SEC-01 | 输入边界 | P0 | `deposit(0)` | revert（Q2 错误名）+ 全部状态不变 |
| SEC-02 | 输入边界 | P0 | `redeem(0)` | revert + 状态不变 |
| SEC-03 | 余额不足 | P0 | `redeem(balance + 1)` | revert + 状态不变 |
| SEC-04 | 池内资产不足 | P0 | 先抽走池内部分资产再赎回 | revert + 无"部分成功"（Q13/Q14 定构造方式） |
| SEC-05 | 授权缺失 | P0 | 未 approve 直接 deposit | revert（来自 ERC-20，Q4）+ 状态不变 |
| SEC-06 | 权限 | P0 | 非 owner 调 `pause()` | revert（Q2）+ `paused` 仍为 false |
| SEC-07 | 权限 | P0 | 非 owner 调 `unpause()` | revert + `paused` 仍为 true |
| SEC-08 | 暂停状态机 | P0 | owner `pause()` 后存/赎 | `paused == true`、emit `Paused(account)`；deposit/redeem 回滚且余额不变；但 `getPoolBalance`/`totalSupply`/`balanceOf` 正常可调用 |
| SEC-09 | 暂停状态机 | P0 | `unpause()` 后存款 | 恢复成功、emit `Unpaused(account)`、1:1 正确 |
| SEC-10 | 重复初始化 | P0 | 二次 `initialize`（任意参数，Q8） | revert + `initialized()` 仍 true + `shareToken()` 未被改写（打印前后值） |
| SEC-11 | 凭证权限 | P0 | 普通账户直调 `mint`/`burn` | 双双 revert + `totalSupply` 不变；只有 `pool.deposit()` 才增供应量 |
| SEC-12 | 异常铸币防护 | P0 | 复用 VUL-02 的同组边界输入 | 要么回滚，要么铸出严格等于存入量；`getPoolBalance` 与 `totalSupply` 保持一致 |

### 5.4 `test/security-regression.test.js` —— 回归闸门

| 场景 ID | describe | 优先级 | 操作 | 关键断言 |
|---|---|---|---|---|
| REG-01 | 攻击前后对比 | P0 | 同一调用序列喂两版 | `console.table` 输出对照；漏洞版成功且超额铸币，修复版回滚或严格 1:1；**"正常存款"一步两版结果必须一致** |
| REG-02 | 不变量 | P0 | ≥10 组随机存赎序列 | INV1 `totalSupply == Σ 凭证余额`（含/不含 `address(0)` 按 Q12）；INV2 `getPoolBalance == 池真实余额`；INV3 取回 ≤ 存入；INV4 `initialized` 单向；INV5 失败交易后状态全等 |
| REG-03 | 极端边界 | P0 | `deposit(1)`、接近全余额、`type(uint256).max` 级 redeem | 不出现溢出式异常铸币：要么 1:1，要么回滚 |
| REG-04 | 冒烟回归 | P0 | 5 条压成一组，用例名含"冒烟" | 支持 `npx hardhat test --grep "冒烟"` 单独跑；任一失败即阻断合并 |

### 5.5 覆盖矩阵自检（避免漏场景）

- 固定 4 个文件全部被使用 ✅
- 正常 / 异常输入 / 权限 / 状态机 / 漏洞演示 / 防护对比 / 不变量 / 极端边界 / 冒烟 九类全覆盖 ✅
- 每个 P0 场景都带"状态未改变"断言 ✅
- 无新增测试文件、无新增 helpers 目录 ✅
