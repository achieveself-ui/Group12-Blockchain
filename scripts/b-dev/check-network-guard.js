const { ethers } = require('hardhat');
const { assertLocal } = require('./compare-local');
async function main() {
  const factory = await ethers.getContractFactory('VulnerablePool');
  try { await factory.deploy(); throw new Error('guard failed: deployed'); }
  catch (e) {
    if (!String(e).includes('LocalOnly')) throw e;
    console.log('PASS: VulnerablePool deployment rejected on in-memory chainId=1 (no public RPC).');
  }
  try { await assertLocal(); throw new Error('script guard failed'); }
  catch (e) {
    if (!String(e).includes('allowed only')) throw e;
    console.log('PASS: comparison script rejected in-memory chainId=1.');
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
