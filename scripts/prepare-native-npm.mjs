import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectNativeClientCandidate} from './native-client-release.mjs';

const targets=[['windows','amd64','win32','x64'],['windows','arm64','win32','arm64'],['linux','amd64','linux','x64'],['linux','arm64','linux','arm64'],['darwin','amd64','darwin','x64'],['darwin','arm64','darwin','arm64']];
const name=(os,arch)=>`@galaxy/native-${os}-${arch}`;
const json=x=>JSON.stringify(x,null,2)+'\n';
// Creates reviewable npm package directories from already prepared candidates.
// Publication and npm pack remain separate explicit operations. The optional
// packages contain the same binary, assets and resolved adapter dependencies as
// the direct archive; the launcher runs the binary at its real package path.
// Go locates candidate resources beside that executable; repair can still use
// its managed prior release and an explicit --package-dir remains authoritative.
export async function prepareNativeNpmPackages({candidates,destination,sourceDirectory}={}){
 if(!isAbsolute(destination)||!isAbsolute(sourceDirectory)||!Array.isArray(candidates)||!candidates.length)throw Error('Absolute output/source and candidate paths required');
 const inspected=[];let version;
 for(const source of candidates){if(!isAbsolute(source))throw Error('Absolute candidate path required');const c=await inspectNativeClientCandidate({source,sourceDirectory});const t=targets.find(([goos,goarch])=>goos===c.manifest.target.goos&&goarch===c.manifest.target.goarch);if(!t||inspected.some(x=>x.t[0]===t[0]&&x.t[1]===t[1]))throw Error('Invalid or duplicate target');if(version&&version!==c.packageJson.version)throw Error('Candidate versions differ');version=c.packageJson.version;inspected.push({source,c,t});}
 await mkdir(destination);
 for(const {source,c,t} of inspected){const dir=join(destination,`${t[0]}-${t[1]}`);await cp(source,dir,{recursive:true,errorOnExist:true,force:false});const pkg={...c.packageJson,name:name(t[0],t[1]),private:false,os:[t[2]],cpu:[t[3]],bin:{'galaxy-native':t[0]==='windows'?'galaxy.exe':'galaxy'},exports:{'./package.json':'./package.json','./opencode':'./opencode.js'},bundledDependencies:Object.keys(c.packageJson.dependencies)};await writeFile(join(dir,'package.json'),json(pkg));}
 const launcher=join(destination,'launcher');await mkdir(launcher);
 const optionalDependencies=Object.fromEntries(inspected.map(({t:[os,arch]})=>[name(os,arch),version]));
 await writeFile(join(launcher,'package.json'),json({name:'@galaxy/native',version,private:false,type:'module',license:'Apache-2.0',engines:{node:'>=22.13.0'},bin:{galaxy:'./galaxy.mjs'},optionalDependencies}));
 const entry=`#!/usr/bin/env node
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import {constants} from 'node:os';
import {createInterface} from 'node:readline/promises';
const os={win32:'windows',linux:'linux',darwin:'darwin'}[process.platform],arch={x64:'amd64',arm64:'arm64'}[process.arch];
if(!os||!arch){console.error('Galaxy: unsupported platform '+process.platform+'/'+process.arch+'. Use a supported native release.');process.exit(1)}
const require=createRequire(import.meta.url);let dir;
try{dir=dirname(require.resolve('@galaxy/native-'+os+'-'+arch+'/package.json'))}
catch{console.error('Galaxy: platform package missing for '+os+'/'+arch+'. Install the matching platform package with this launcher, or use a complete native release.');process.exit(1)}
const binary=join(dir,os==='windows'?'galaxy.exe':'galaxy');
const initial=process.argv.slice(2),automatic=initial.length===0;
async function run(args,inspectHost){
 return await new Promise(resolve=>{
  let stderr='';
  const child=spawn(binary,args,{stdio:inspectHost?['inherit','inherit','pipe']:'inherit',shell:false,windowsHide:true});
  const signals=['SIGINT','SIGTERM'];
  const handlers=new Map(signals.map(signal=>[signal,()=>{if(!child.killed)child.kill(signal)}]));
  for(const [signal,handler] of handlers)process.on(signal,handler);
  if(inspectHost)child.stderr.on('data',chunk=>{process.stderr.write(chunk);stderr=(stderr+chunk.toString()).slice(-8192)});
  let failed=false;
  child.once('error',error=>{failed=true;console.error('Galaxy: cannot start the native client ('+(error.code||'unknown error')+'). Check the platform package and executable permissions.');});
  child.once('close',(code,signal)=>{
   for(const [name,handler] of handlers)process.removeListener(name,handler);
   resolve({code:failed?1:code??1,signal,hostRequired:inspectHost&&stderr.includes('setup_host_required')});
  });
 });
}
let result=await run(automatic?['install']:initial,automatic);
if(result.hostRequired&&!result.signal){
 if(process.stdin.isTTY&&process.stderr.isTTY){
  const rl=createInterface({input:process.stdin,output:process.stderr});
  const host=(await rl.question('请输入当前宿主 ID（如 opencode、codex、claude-code；回车取消）：')).trim();rl.close();
  if(host)result=await run(['install','--host',host],false);
 }else console.error('Galaxy: choose the current host with galaxy install --host <host-id>.');
}
if(result.signal){try{process.kill(process.pid,result.signal)}catch{process.exitCode=128+(constants.signals[result.signal]||1)}}else process.exitCode=result.code;
`;
 await writeFile(join(launcher,'galaxy.mjs'),entry,{mode:0o755});
 return {destination,version,targets:inspected.map(({t})=>({goos:t[0],goarch:t[1],package:name(t[0],t[1])})),publicationReady:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [destination,sourceDirectory,...candidates]=process.argv.slice(2);console.log(JSON.stringify(await prepareNativeNpmPackages({destination,sourceDirectory,candidates})));
}
