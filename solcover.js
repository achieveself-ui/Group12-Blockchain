// ============================================================================
// .solcover.js —— solidity-coverage 的配置（`npx hardhat coverage` 会读这个文件）
// ----------------------------------------------------------------------------
// 为什么单独一个文件？覆盖率工具的配置不放在 hardhat.config.js 里，
// 而是由 solidity-coverage 自己读 .solcover.js。这点在小组会上容易被问。
// ============================================================================

module.exports = {
  // skipFiles：不计入覆盖率的文件
  //   本项目暂不跳过任何合约 —— 包括教学版 VulnerablePool。
  //   理由：教学版的"故意缺陷"若被跳过，报告里就无法解释"为什么这段分支没被测到"。
  //   正确做法是照常统计，然后在 security-report 里把这些未覆盖分支标注为
  //   "设计意图（教学演示），非未处理缺陷"。
  //   注意：test/ 目录本身不会被统计，不需要在这里排除。
  skipFiles: [],

  // istanbulReporter：输出格式
  //   text → 终端直接看（贴进日志）
  //   html → coverage/index.html，答辩时逐行看哪条分支没覆盖
  //   json → 给脚本/报告做二次统计
  //   lcov → 部分 CI 平台用；本项目不需要，省时间
  istanbulReporter: ["text", "html", "json"],

  // configureYulOptimizer：解决 "optimizer + coverage" 的经典冲突
  //   现象：hardhat.config.js 开了 optimizer，跑 coverage 时报
  //        "stack too deep" 或行号错位，覆盖率数字变成 0%。
  //   原因：coverage 会先给源码插桩，再交给 solc；插桩后的表达式层级变深，
  //        与 optimizer 的 Yul 优化器产生冲突。
  //   置 true 后，solidity-coverage 会在插桩阶段改用兼容的 Yul 配置。
  //   本项目 Solidity 0.8.24 + optimizer runs 200，属于会触发该问题的组合。
  configureYulOptimizer: true,

  // 覆盖率模式下同样需要放宽超时（与 hardhat.config.js 的 mocha.timeout 一致）
  mocha: {
    timeout: 120000,
  },
};
