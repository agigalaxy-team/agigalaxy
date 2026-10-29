import { readFile,lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { prepareGovernanceBundle } from '../../galaxy-client/src/node/governance-review.mjs';
try{
  const [path]=process.argv.slice(2);if(typeof path!=='string'||!isAbsolute(path))throw new Error();
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error();
  const command=JSON.parse(await readFile(path,'utf8'));
  if(Object.keys(command).some(key=>!['configurationPath','reviewPath','authoritiesPath','endpoint','directory'].includes(key)))throw new Error();
  console.log(JSON.stringify({event:'governance_bundle_prepared',...await prepareGovernanceBundle(command)}));
}catch{console.error(JSON.stringify({event:'governance_bundle_preparation_failed'}));process.exitCode=1;}
