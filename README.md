# DeFi Shield

DeFi 流动性池安全演示系统（课程项目）。用简化的智能合约模型展示异常铸币如何影响资金池，再用修复版和自动化测试证明防护是否有效。

- 本项目是**教学模型**，不是金融产品，也不复刻 Yearn yETH 真实合约或完整攻击链。
- 漏洞教学版 `VulnerablePool` **只允许在本地 chainId=31337 运行**；对外测试网只部署修复版 `SecurePool`。
- 五项核心功能、固定接口与目录以项目统一说明 v2.0 为准（见仓库内 docx 与 `docs/test-plan.md`）。

## 版本基线（由 B 锁定，E 沿用）

| 组件 | 版本 |
| --- | --- |
| Node.js | 22.16.0（作为 devDependency 锁定，npm scripts 会把它加入 PATH） |
| Hardhat | 2.26.3 |
| Solidity | 0.8.24（使用锁定的 npm solc-js 编译，不额外下载编译器） |
| OpenZeppelin Contracts | 5.0.2 |
| ethers | 6.13.4 |
| chai / hardhat-chai-matchers | 4.5.0 / 2.0.8 |

本机若未全局安装 Node，不影响 `npm run` 脚本；但执行 `npm` 本身需要系统里有 npm。

## 目录现状

```
contracts/            TestToken / PoolShareToken / SecurePool / VulnerablePool（B）
test/b-dev/           B 的本地开发测试
test/*.t.sol          C 的 Foundry 测试资料（未迁移，不作为验收结果）
scripts/b-dev/        B 的本地对比与验证脚本
scripts/              E：deploy-local.js / deploy-sepolia.js / setup-demo.js
docs/validation/      B、E 的实际运行记录（不含密钥）
frontend/             D 负责，尚未交付
```

## 安装

```powershell
npm.cmd ci
```

需要联网安装依赖。`node_modules/node` 提供固定版本的 Node 可执行文件。

## 编译与测试

```powershell
npm.cmd run compile
npm.cmd test
npm.cmd run demo:b       # B 的漏洞版/修复版本地对比（内存网络）
npm.cmd run validate:b   # 编译 + 测试 + 对比 + 网络限制检查，结果写入 docs/validation/
```

B 的最近一次记录：编译通过，Hardhat 测试 16 passing，证据在 `docs/validation/`。这些结果属于 B 的交付，不替代 C 的正式测试与安全报告。

## 本地部署与演示（E）

本地演示需要一条**持久链**，否则进程结束后合约地址失效。

终端 1：

```powershell
npx hardhat node
```

终端 2（同一目录）：

```powershell
npm.cmd run deploy:local
npm.cmd run demo:setup
```

`deploy:local` 的行为：

- 只允许 `--network localhost`，且实际 chainId 必须是 31337；
- 部署白名单：`TestToken` → `SecurePool` → `PoolShareToken(pool)`；
- 由部署者调用 `initialize(asset, share)`，随后校验 `initialized()`、地址绑定、`owner()`、未暂停、凭证初始供应为 0；
- 给部署者和 3 个演示账户各 mint 1,000,000 最小单位 DST；
- 部署记录写入 `docs/validation/E-deploy-local.json`（地址、交易哈希、校验结果）。

`demo:setup` 读取上述记录，校验链上代码与初始化状态后，准备演示数据（mint / approve / 定额 deposit），重复执行不会重复存款。

> 本地部署脚本**不部署** `VulnerablePool`，也不部署 `contracts/dev`。漏洞演示仍使用 `npm run demo:b`。

## Sepolia 部署（仅修复版）

**当前已部署（2026-11-10，chainId 11155111）**

| 合约 | 地址 |
| --- | --- |
| TestToken | `0x4948A77A5075914B20e1A8450a00c69D27Faab14` |
| SecurePool | `0xb06f28E8b04F670E19DBCA4Aa2bB59226B7Ae862` |
| PoolShareToken | `0xd2De1791A6Eb32b3b40c9E8EB6368CeB663DC353` |

交易哈希与校验结果见 `docs/validation/E-deploy-sepolia.json`，说明见 `docs/E-sepolia-deployment.md`，前端引用 `frontend/src/contracts/addresses.ts`。Sepolia 上不存在 `VulnerablePool`。

前提：一个只用于测试的账户，且有 Sepolia ETH（水龙头领取）。

```powershell
Copy-Item .env.example .env
# 填写 SEPOLIA_RPC_URL 与 DEPLOYER_PRIVATE_KEY
npm.cmd run deploy:sepolia
```

脚本的安全边界：

- 网络名必须是 `sepolia`，实际 chainId 必须是 11155111；
- 缺少 `SEPOLIA_RPC_URL` 或 `DEPLOYER_PRIVATE_KEY` 时直接拒绝运行；
- 只部署 `TestToken`、`SecurePool`、`PoolShareToken` 三个白名单合约，**绝不会部署 `VulnerablePool`**；
- 部署后校验初始化与绑定关系，再向部署者 mint 测试资产；
- 记录写入 `docs/validation/E-deploy-sepolia.json`，含区块浏览器地址与交易链接，可外部核验。

`.env` 已被 `.gitignore` 忽略，禁止提交私钥、助记词或真实 API Key。

## 前端

由 D 负责，当前仓库没有可运行的前端代码。合约地址已整理到 `frontend/src/contracts/addresses.ts`（Sepolia，chainId 11155111），前端接入时直接引用，不要自行复制地址；ABI 取 `artifacts/contracts/<Name>.sol/<Name>.json` 的 `abi` 字段，并校验钱包网络一致。

## 已知限制

- 依赖审计告警（B 记录：9 high / 3 moderate / 10 low）尚未消除，当前工具链不适合作为公共服务运行环境。
- 未执行 Slither、覆盖率统计与正式安全报告（C 负责）。
- `main` 分支目前没有合约代码；E 的脚本基于 `feature/b-contracts` 拉出的分支，需由 A 按顺序合并。
- 本地部署记录只对当前链有效；内存网络进程结束后地址全部失效。

## 验证状态（E）

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 编译 | 通过（17 个 Solidity 文件） | `docs/validation/E-verify.log` |
| Hardhat 测试 | 15 passing；1 个 1000 轮回归用例在本机超时，单独放宽超时后通过 | `docs/validation/E-verify.log` |
| 本地部署 | 通过（地址与交易哈希已记录） | `docs/validation/E-deploy-local.json`、`E-deploy-local.log` |
| 演示数据 | 通过（池内资产 17500，凭证总量 17500，重复执行不重复存款） | `docs/validation/E-demo-setup.log` |
| Sepolia 部署 | 通过（3 合约 + initialize + mint，链上校验全部 true） | `docs/validation/E-deploy-sepolia.json`、`docs/E-sepolia-deployment.md` |

## 故障排查

- `node` 不是内部或外部命令：用 `npm.cmd run ...`，或安装 Node 22.16.0。
- 报错提示合约地址没有代码：部署记录属于已结束的内存网络，请改用 `npx hardhat node` + `deploy:local`。
- 默认端口 8545 被占用：先结束旧的 Hardhat 进程。
- 编译提示下载 solc 失败：确认 `solc@0.8.24` 已随 `npm ci` 安装；本配置使用本地 solc-js。
- `npm ci` 连接 registry.npmjs.org 超时：可临时使用镜像
  `npm.cmd ci --registry=https://registry.npmmirror.com --replace-registry-host=always`。
- `npm test` 中 1000 轮回归用例超时（本机约 760 秒，用例内限制 240 秒）：这是执行速度问题，不是断言失败；
  在较慢机器上可临时调大 `test/b-dev/regression.test.js` 的 `this.timeout` 后重跑，不要把它当成代码缺陷。

