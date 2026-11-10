# Sepolia 部署记录（E）

本文档供 A（项目管理/文档）与 D（前端）使用。机器可读记录见 `docs/validation/E-deploy-sepolia.json`。

## 网络

| 项目 | 值 |
| --- | --- |
| 网络 | Sepolia 测试网 |
| chainId | `11155111` |
| 部署账户（公开地址） | `0xbE0A420cE5e9B56Ae7e3AFb7fF299D17581219E9` |
| 部署时间（UTC） | `2026-11-10T14:52:51.561Z` |
| 区块浏览器 | https://sepolia.etherscan.io |

## 合约地址

| 合约 | 地址 | 浏览器 |
| --- | --- | --- |
| TestToken（测试资产） | `0x4948A77A5075914B20e1A8450a00c69D27Faab14` | https://sepolia.etherscan.io/address/0x4948A77A5075914B20e1A8450a00c69D27Faab14 |
| SecurePool（修复版池） | `0xb06f28E8b04F670E19DBCA4Aa2bB59226B7Ae862` | https://sepolia.etherscan.io/address/0xb06f28E8b04F670E19DBCA4Aa2bB59226B7Ae862 |
| PoolShareToken（凭证） | `0xd2De1791A6Eb32b3b40c9E8EB6368CeB663DC353` | https://sepolia.etherscan.io/address/0xd2De1791A6Eb32b3b40c9E8EB6368CeB663DC353 |

## 部署交易

| 步骤 | 交易哈希 |
| --- | --- |
| 部署 TestToken | https://sepolia.etherscan.io/tx/0xa807908f27ae828195fd6dfad779bf67f75f53d411ea35ba9bcbe0d751eb7918 |
| 部署 SecurePool | https://sepolia.etherscan.io/tx/0x61eeec0c66703d072c92dd977b550e0699bd3f8426fb435a57962a89048851b4 |
| 部署 PoolShareToken | https://sepolia.etherscan.io/tx/0x1154d1241597dd53a08e13ec9f905ee1f6c08e76e6cbfd8c4f0be60ad7513e74 |
| initialize | https://sepolia.etherscan.io/tx/0xb2cdd4ef1f37135c9e07581646eed335f6bda25781e954cf50d304228d99e39a |
| 给部署者 mint 测试资产 | https://sepolia.etherscan.io/tx/0xbf7cc3eb2fc13b67294fc2aed238eb48cac7397d25d7b6f3e1476e9351f213a8 |

## 部署后校验（链上读取结果）

| 检查项 | 结果 |
| --- | --- |
| `initialized()` | true |
| `assetToken()` 指向 TestToken | true |
| `shareToken()` 指向 PoolShareToken | true |
| 凭证 `pool()` 绑定 SecurePool | true |
| `owner()` 与部署账户一致 | true |
| `paused()` | false |
| 凭证初始供应量为 0 | true |

## 使用方须知

### D（前端）

- 地址已写入 `frontend/src/contracts/addresses.ts` 的 `DEPLOYMENTS[11155111]`，直接引用，不要再复制一份。
- ABI 取自 `artifacts/contracts/<Name>.sol/<Name>.json` 的 `abi` 字段（编译产物）。
- 前端必须校验钱包 chainId 为 `11155111`，不一致时提示切换网络，不要静默降级。
- Sepolia 上**没有** `VulnerablePool`，漏洞对比演示只能用本地链（`npm run demo:b`）。

### A（文档）

- 三个地址均可公开引用，无敏感信息。
- 部署账户私钥、RPC API Key 只在本地 `.env`，未提交、不在本文档中。
- 该部署为教学演示用，测试资产无真实价值。

## 复现方式

```powershell
Copy-Item .env.example .env
# 填写 SEPOLIA_RPC_URL（必须是 eth-sepolia 端点）与 DEPLOYER_PRIVATE_KEY（0x + 64 位）
npm.cmd run deploy:sepolia
```

脚本会强制校验 network 为 `sepolia` 且 chainId 为 `11155111`，只部署三个白名单合约，缺配置或余额不足直接拒绝运行。
