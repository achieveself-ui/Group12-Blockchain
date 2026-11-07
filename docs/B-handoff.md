# B 开发交接（2026-11-07，Asia/Shanghai）

状态：四个合约、本地开发测试、演示与文档已完成；供组内审核和集成，不代表全项目完成或全面安全审计。没有部署公共网络、提交远程仓库或创建 PR。

## 给 A：审核与集成

- 审核 `api-spec-draft-B.md`，确认无参 TestToken/SecurePool、PoolShareToken(pool)、18 decimals、无返回值存赎、事件 indexed、错误类型。审核通过后再形成正式 api-spec.md。
- 批准/调整教学模型：原比例公式无法推出计划的天量凭证；本实现使用缓存残留+错误 unchecked 减法，实际余额比例赎回。没有硬编码2.35×10^23，也未声称已有 B 同意。
- 确认 Hardhat 主框架，原 Foundry 资料不执行且原样保留；B 测试置于 `test/b-dev/`，不占用 C 正式文件名。
- 确认人工日志改放 `docs/validation/`，避免 Hardhat 清理 artifacts 时损失证据。
- 分配依赖安全告警处理给 C/E，审核后决定版本升级策略。不要直接执行 npm audit fix --force，它会建议 Hardhat 主版本迁移。

## 给 C：独立测试与安全分析

- 构造及错误细节见接口草案；OZ Paused/Unpaused 的 account **没有 indexed**。原 PoolAsserts 中的索引声明需要迁移时修正，不能原样视为最终接口。
- `test/b-dev/secure.test.js`覆盖初始化权限/重复/参数、未初始化、存赎与多用户、零/超额/缺授权、凭证权限、暂停、事件、捐赠、清池重存、最大整数、异常资产和回调重入。
- `test/b-dev/regression.test.js`含固定种子0x5eed的1000轮混合操作与1000次即时存赎。混合金额1–100，往返金额1–1,000,000；不是数学证明，也不是计划中完整1–10^24范围的模糊测试替代。
- `test/b-dev/vulnerable.test.js`验证异常铸币、真实测试资产损失、安全对比和任意用户重初始化。
- 测试通过状态快照检查用户资产、凭证、总供应、池资产、授权及失败交易无日志；成功存赎检查事件和变化量。测试回滚不是只看报错。
- 资产不足状态通过独立 `contracts/dev/AdversarialAsset.sol` 的测试扣款函数构造；正式 TestToken/SecurePool 无测试后门。该 mock 还提供手续费、false 返回、重入回调及6位小数场景。
- 后续补：正式测试计划更新、更多随机种子和持有者转账路径、不兼容/恶意凭证合约、所有权变更/放弃、额外初始化异常、非标准ERC20边界、覆盖率、Slither及人工审阅。对故意漏洞版的发现必须单独标注，不要为了报告零告警隐藏漏洞。
- 未执行 Foundry、solidity-coverage、Slither；未生成 C 的 security-report.md，未宣称满足覆盖率门槛或静态分析无 High。

## 给 D：前端对接

- 使用 `artifacts/contracts/TestToken.sol/TestToken.json` 等四份真实编译产物的 abi 字段；不把整个 artifacts 当作前端源代码。
- 18 decimals；所有链上金额用 bigint/string，避免 Number 精度损失。mint 仅管理员；普通用户先 approve 资产给池，再 deposit。redeem 无需 share approve。
- 查询 getPoolBalance、shareToken、initialized、paused、owner、资产和凭证 balanceOf/totalSupply。存赎无 Solidity 返回值，以交易回执事件及读余额更新 UI。
- 本地对比数据见 B-comparison.json，所有地址和交易来自临时内存链，进程结束后失效；不能直接当持久前端配置或区块浏览器链接。
- 漏洞入口必须仅本地，显示教学标识；本次不实现前端。

## 给 E：环境与部署集成

实际：Windows x64，Node22.16.0，Hardhat2.26.3，Solidity0.8.24（solc-js，优化200，EVM paris），OZ5.0.2，ethers6.13.4，hardhat-ethers3.0.8，chai-matchers2.0.8，Chai4.5.0。npm bootstrap为10.7.0；系统Node18.20.4未用于实际验证。

Node22.16.0以本地devDependency安装，避免替换用户系统Node。版本由package.json/package-lock.json及.nvmrc固定；不是“当前最新版本”。采用成熟CommonJS Hardhat2组合以对齐JavaScript及OZ5错误行为。后续升级需联合回归。

在项目根目录执行（PowerShell）：

```powershell
npm.cmd ci
npm.cmd run compile
npm.cmd test
npm.cmd run demo:b
npm.cmd run validate:b
```

以上为供复现的命令；本次实际安装执行了 `npm.cmd install --no-fund --fetch-retries=0 --fetch-timeout=30000 --cache .npm-cache`，实际完整验证执行了 `.\node_modules\node\bin\node.exe scripts\b-dev\validate.js`。npm scripts会把本地node加入PATH；也可使用上述显式路径确保运行版本。

首次npm安装在沙箱DNS解析失败；获授权后联网安装成功。首次Hardhat调用因AppData配置目录写权限失败；获授权后运行成功。未通过替代工具绕过权限。

`validate.js` 顺序执行 compile --force、test、compare-local、模拟非本地链ID检查，并保存退出码与输出。编译器从锁定npm包加载，不依赖Hardhat额外下载编译器。

部署顺序：TestToken → SecurePool → PoolShareToken(pool) → pool.owner调用initialize → 验证绑定/owner/initialized → 发放测试资产。漏洞版仅替换池构造为VulnerablePool，且只能本地；**禁止按“遍历contracts自动部署全部合约”方式部署**，contracts/dev也绝不部署。E正式部署脚本应明确白名单只包含TestToken、SecurePool、PoolShareToken。

本配置没有公共网络/RPC/私钥。scripts/b-dev仅B开发验证，不代替E的deploy-local.js、deploy-sepolia.js或正式部署记录。

## 实际结果与证据

| 检查 | 实际结果 | 证据 |
|---|---|---|
| 编译 | 17个Solidity文件成功（包括依赖及测试mock） | validation/B-compile.log |
| Hardhat测试 | 16 passing，0失败；含两组1000轮循环 | validation/B-tests.log |
| 演示 | 漏洞版净获利9999，安全版0；逐步余额、事件、交易哈希有记录 | validation/B-demo.log、B-comparison.json |
| 网络限制 | 内存chainId=1时合约部署与演示脚本均被拒 | validation/B-network-guard.log |
| 依赖审计 | 22：9 high、3 moderate、10 low、0 critical；未消除 | validation/B-npm-audit.json |

金额全部为最小单位。漏洞版存16铸 `2^256-10984`，赎回10015；安全版存16铸16赎16。受害者随后赎回：漏洞版1，安全版10000。

npm告警主要涉及开发链依赖，如Hardhat下的undici、adm-zip、serialize-javascript、solc下的tmp、ethers下的ws，以及关联包。OZ未出现在本次npm告警列表，但这不证明合约安全。npm审计不是Solidity静态分析；未核实每项告警在本演示中的可达性，不能宣称无影响。依赖存在已知告警，不建议把当前工具链直接当公共服务运行环境。

未完成范围：A最终批准、C正式测试/覆盖率/静态扫描、D前端、E持久本地及Sepolia部署、团队总报告与演示。等待这些整合工作期间，B应继续响应实际测试反馈。
