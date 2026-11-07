// Run using the locked Node binary, or npm run validate:b (npm puts it on PATH).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname,'../..');
process.chdir(root);
const output = path.join(root,'docs/validation');
fs.mkdirSync(output,{recursive:true});
const versions = {node:process.version,platform:process.platform,arch:process.arch};
for (const dep of ['hardhat','@openzeppelin/contracts','@nomicfoundation/hardhat-ethers',
  '@nomicfoundation/hardhat-chai-matchers','ethers','chai','solc'])
  versions[dep] = dep === 'ethers' ? require('ethers').version : require(`${dep}/package.json`).version;
versions.solcLong = require('solc').version();
fs.writeFileSync(path.join(output,'B-environment.json'),JSON.stringify(versions,null,2)+'\n');
const cli = require.resolve('hardhat/internal/cli/cli');
const jobs = [
  ['compile',['compile','--force']],
  ['tests',['test']],
  ['demo',['run','scripts/b-dev/compare-local.js','--no-compile']],
  ['network-guard',['run','scripts/b-dev/check-network-guard.js','--config','scripts/b-dev/guard.config.js','--no-compile']]
];
for (const [name,args] of jobs) {
  console.log(`Running ${name}...`);
  const result = spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',env:{...process.env,FORCE_COLOR:'0'},maxBuffer:32*1024*1024});
  const log = `Command: node hardhat/internal/cli/cli ${args.join(' ')}\nNode: ${process.version}\nExit code: ${result.status}\n${result.stdout||''}${result.stderr||''}${result.error||''}`;
  fs.writeFileSync(path.join(output,`B-${name}.log`),log);
  console.log(result.stdout||'');
  if (result.stderr) console.error(result.stderr);
  if (result.status !== 0) { process.exitCode=1; break; }
}
