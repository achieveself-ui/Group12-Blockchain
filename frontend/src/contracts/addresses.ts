// Sepolia 部署地址
// 来源唯一：本文件与部署记录同步维护
// 注意：Sepolia 仅部署修复版三个合约，不存在 VulnerablePool。

export const SEPOLIA_CHAIN_ID = 11155111;

export const EXPLORER_BASE_URL = 'https://sepolia.etherscan.io';

export interface DeploymentAddresses {
  assetToken: `0x${string}`;
  securePool: `0x${string}`;
  shareToken: `0x${string}`;
}

export const DEPLOYMENTS: Record<number, DeploymentAddresses> = {
  [SEPOLIA_CHAIN_ID]: {
    assetToken: '0x4948A77A5075914B20e1A8450a00c69D27Faab14',
    securePool: '0xb06f28E8b04F670E19DBCA4Aa2bB59226B7Ae862',
    shareToken: '0xd2De1791A6Eb32b3b40c9E8EB6368CeB663DC353',
  },
};
