import {readFile,writeFile,mkdir,rm,mkdtemp} from 'node:fs/promises';
import {join,resolve,isAbsolute,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {inspectNativeClientCandidate} from './native-client-release.mjs';
const run=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
// Exercises the actual Go host-config generator in an isolated synthetic
// directory. It does not inspect or modify a real profile or identity.
export async function verifyNativeCandidate(candidate,{sourceDirectory=root}={}){
 const {manifest}=await inspectNativeClientCandidate({source:candidate,sourceDirectory});
 const hostOS={win32:'windows',linux:'linux',darwin:'darwin'}[process.platform],hostArch={x64:'amd64',arm64:'arm64'}[process.arch];
 if(manifest.target.goos!==hostOS||manifest.target.goarch!==hostArch)throw Error('Candidate execution requires its matching target platform');
 const temp=await mkdtemp(join(tmpdir(),'galaxy-native-config-check-'));
 try{
  const config=join(temp,'public.json'),output=join(temp,'hosts');await writeFile(config,'{}\n',{flag:'wx'});
  const executable=join(candidate,manifest.mcp.command);
  const result=await run(executable,['host-configs',config,output,'--hosts','claude-code,codex,cursor'],{cwd:root,windowsHide:true});
  const receipt=JSON.parse(result.stdout);assert.equal(receipt.actualSettingsModified,false);assert.equal(receipt.hostRuntimeTested,false);
  for(const path of ['claude-code/.mcp.json','codex/galaxy-native-v2/.mcp.json','cursor/.cursor/mcp.json']){
   const server=JSON.parse(await readFile(join(output,path),'utf8')).mcpServers.galaxy;
   assert.equal(resolve(server.command),resolve(executable));assert.deepEqual(server.args,['native']);assert.equal(server.env.GALAXY_NATIVE_CONFIG,config);
  }
  return {candidate,hostConfigurations:'passed-synthetic-only',actualHostAcceptance:false,actualSettingsModified:false};
 }finally{const child=relative(tmpdir(),temp);if(!child||child.startsWith('..')||isAbsolute(child))throw Error('Invalid temporary cleanup target');await rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3||!isAbsolute(process.argv[2]))throw Error('Usage: node scripts/verify-native-v2-candidate.mjs ABSOLUTE_CANDIDATE');
 console.log(JSON.stringify(await verifyNativeCandidate(process.argv[2])));
}
