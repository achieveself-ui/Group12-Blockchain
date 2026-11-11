// ============================================================================
// hardhat.config.js —— 测试相关配置建议（v2 统一说明下的 Hardhat 基线）
// ----------------------------------------------------------------------------
// 用法：
//   ① 如果仓库里还没有配置文件，直接用它；
//   ② 如果 E 已经有配置，把【solidity】与【mocha】两段合并进去，
//      networks 里 E 的 sepolia 配置不要被覆盖（部署由 E 负责，C 不改网络配置）。
//
// 每个配置项后面都写了"它解决什么问题"，小组会上可以直接照着讲。
// ============================================================================

require("@nomicfoundation/hardhat-toolbox");
// 关于插件：hardhat-toolbox 是一个"全家桶"，已经包含
//   · @nomicfoundation/hardhat-ethers          → 测试里用 ethers v6
//   · @nomicfoundation/hardhat-chai-matchers   → expect(tx).to.emit / revertedWithCustomError
//   · solidity-coverage                        → npx hardhat coverage
//   · hardhat-gas-reporter / typechain 等
// 如果项目是"只装单个插件"的精简方式，最小集必须显式 require 这三行：
//   require("@nomicfoundation/hardhat-ethers");
//   require("@nomicfoundation/hardhat-chai-matchers");
//   require("solidity-coverage");
// 少了 chai-matchers，测试里 `expect(tx).to.emit(...)` 会直接报 "not a function"。

const { SEPOLIA_RPC_URL, SEPOLIA_PRIVATE_KEY } = process.env;

module.exports = {
  // -------------------------------------------------------------------------
  // solidity：编译器版本与优化设置
  // -------------------------------------------------------------------------
  solidity: {
    // 版本锁定 0.8.24 的理由（这条会被问）：
    //   ① 0.8.x 默认开启 checked arithmetic，整数溢出/下溢会直接 revert。
    //      这是本项目"不安全减法"那一环的天然兜底——真下溢不会悄悄发生。
    //      所以千万不能为了兼容旧代码把版本降到 0.7 以下。
    //   ② 0.8.24 是 v2 说明里 4 个合约能一起编译的稳定版本，且 Sepolia 支持其默认 evmVersion。
    //   ③ 版本写死而不是写 "^0.8.0"，是为了让"编译结果"可复现：
    //      否则不同人装到不同 solc，覆盖率与字节码都无法对比。
    version: "0.8.24",

    settings: {
      // optimizer：优化器开关 + 运行次数
      //   enabled: true  → 部署字节码更小、链上更省 gas（Sepolia 部署需要）
      //   runs: 200      → "部署一次、调用两百次"的权衡点。数值越大，运行时代码越省 gas，
      //                    但部署成本越高。200 是通用默认值，本项目功能简单，够用。
      //   注意：optimizer 与 solidity-coverage 同时开启时，个别版本会出现
      //        "stack too deep" 或行号错位。解决方式见 .solcover.js 的 configureYulOptimizer。
      optimizer: {
        enabled: true,
        runs: 200,
      },

      // evmVersion：默认跟随 solc 版本。若 E 在 Sepolia 部署时报
      //   "invalid opcode" / "invalid code"（常见于 PUSH0 指令不被节点接受），
      //   把它显式降到上一代：
      // evmVersion: "paris",
    },
  },

  // -------------------------------------------------------------------------
  // networks：测试只跑本地内存链；Sepolia 只给 E 部署用
  // -------------------------------------------------------------------------
  networks: {
    hardhat: {
      // chainId 显式写成 31337：
      //   vulnerable-demo.test.js 的 VUL-06 会断言 chainId == 31337，
      //   用来防止"教学漏洞版被误跑到公共网络"。写显式值避免默认值随版本变化。
      chainId: 31337,

      // 允许超大合约：默认 false。保持 false 是有意的——
      //   合约一旦超过 24KB，编译/部署阶段就会报错，逼我们尽早拆分，
      //   而不是等到 Sepolia 部署时才炸。
      allowUnlimitedContractSize: false,
    },

    // Sepolia：仅在环境变量齐全时注册，避免 CI / 本地缺变量时配置报错。
    // 部署由 E 负责；C 的测试**永远不加 --network**，只跑上面的 hardhat 内存链。
    ...(SEPOLIA_RPC_URL && SEPOLIA_PRIVATE_KEY
      ? {
          sepolia: {
            url: SEPOLIA_RPC_URL,
            accounts: [SEPOLIA_PRIVATE_KEY],
          },
        }
      : {}),
  },

  // -------------------------------------------------------------------------
  // mocha：测试运行器（Hardhat 内置，不需要额外装）
  // -------------------------------------------------------------------------
  mocha: {
    // timeout：单个用例的超时（毫秒），默认 40000。
    //   调到 120000 的原因：npx hardhat coverage 会给每个合约插桩，
    //   部署与调用都变慢，默认 40s 在覆盖率模式下容易误报超时（看起来像测试失败）。
    //   注意：timeout 只影响"等待多久算失败"，不会让失败的用例变通过。
    timeout: 120000,

    // slow：超过这个耗时会用黄色标出"慢用例"，方便发现夹具写得低效。
    slow: 2000,
  },

  // -------------------------------------------------------------------------
  // gasReporter：默认关闭
  // -------------------------------------------------------------------------
  // 本项目不把 gas 作为验收指标（test-plan 1.2 已声明不测 gas）。
  // 需要给报告加数据时临时 `REPORT_GAS=true npx hardhat test` 即可。
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};
