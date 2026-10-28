import {build,version as esbuildVersion} from 'esbuild';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,relative,join,isAbsolute,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {componentRelease,INITIAL_VERSION} from './release-identifiers.mjs';
import {buildCompactApp} from '../integrations/native-v2/compact-app/build.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex');
const packageName=path=>path.startsWith('@')?path.split('/').slice(0,2).join('/'):path.split('/')[0];
// Native bundles have one dependency namespace. Reconcile these two observed
// local patch versions to the current Official/A2A lock; candidate HTTP/stdio
// checks validate the selected runtime. Future unreviewed differences fail.
const nativeReconciliation={jose:{selected:'6.2.12',inputs:['6.2.10','6.2.12']}};
async function dependencyVersion(name,inputs){
 const importers=Object.entries(inputs).filter(([,value])=>value.imports.some(i=>i.external&&packageName(i.path)===name)).map(([source])=>source);
 /** @type {Set<string>} */
 const versions=new Set();
 for(const source of importers.length?importers:['package.json']){
  let directory=dirname(resolve(root,source)),found=false;
  while(directory===resolve(root)||directory.startsWith(resolve(root)+sep)){
   try{const pkg=JSON.parse(await readFile(join(directory,'node_modules',name,'package.json'),'utf8'));
    if(pkg.name!==name)throw new Error('External native dependency identity differs');versions.add(pkg.version);found=true;break;
   }catch(error){if(error.code!=='ENOENT')throw error;}
   if(directory===resolve(root))break;directory=dirname(directory);
  }
  if(!found)throw new Error('Unresolved native dependency '+name+' imported by '+source);
 }
 const choice=nativeReconciliation[name];
 if(versions.size!==1&&(!choice||![...versions].every(v=>choice.inputs.includes(v))))throw new Error('Multiple native dependency versions require explicit reconciliation: '+name);
 return {selected:versions.size===1?[...versions][0]:choice.selected,observed:[...versions].sort((a,b)=>a<b?-1:a>b?1:0)};
}
// Normal source build entry for the Go Native candidate. It never changes a
// previously signed release, installed command, or host configuration.
export async function buildGoNativeCandidate({destination,sourceDirectory=root,version=INITIAL_VERSION,goExecutable='go',goos=process.platform==='win32'?'windows':process.platform,goarch=process.arch==='x64'?'amd64':process.arch}){
 if(!isAbsolute(destination)||!isAbsolute(sourceDirectory)||typeof goExecutable!=='string'||!goExecutable.trim())throw Error('Absolute candidate/source and nonempty Go command required');
 if(!['windows','linux','darwin'].includes(goos)||!['amd64','arm64'].includes(goarch))throw Error('Unsupported Go Native candidate target');
 componentRelease('client',version);
 const binary=goos==='windows'?'galaxy.exe':'galaxy';
 // mkdir without recursive/exist-ok protects every existing release directory.
 await mkdir(destination);
 const run=promisify(execFile);
 const {stdout:compiler}=await run(goExecutable,['version'],{cwd:join(sourceDirectory,'go'),windowsHide:true});
 await run(goExecutable,['build','-mod=readonly','-trimpath','-buildvcs=false','-o',join(destination,binary),'./cmd/galaxy'],{cwd:join(sourceDirectory,'go'),windowsHide:true,env:{...process.env,GOOS:goos,GOARCH:goarch,CGO_ENABLED:'0',GOTOOLCHAIN:'local',GOFLAGS:'-mod=readonly'}});
 const entry=`import {fileURLToPath} from 'node:url';import {createNativeGalaxyPlugin as createPlugin} from './integrations/host-adapters/opencode-stable/native-galaxy.tui.ts';const executable=fileURLToPath(new URL('./${binary}',import.meta.url));export function createNativeGalaxyPlugin(options={}){return createPlugin({...options,backend:'go',executable:options.executable??executable});}export default createNativeGalaxyPlugin();`;
 const result=await build({absWorkingDir:sourceDirectory,stdin:{contents:entry,resolveDir:sourceDirectory,sourcefile:'go-opencode-candidate.mjs',loader:'js'},outfile:join(destination,'opencode.js'),bundle:true,splitting:false,platform:'node',format:'esm',target:'node22',packages:'external',external:['bun:sqlite'],metafile:true,write:false,sourcemap:false,
  plugins:[{name:'exclude-legacy-native-process',setup(builder){builder.onResolve({filter:/legacy-runtime\.mjs$/},()=>({path:join(sourceDirectory,'integrations/host-adapters/opencode-stable/bridge/legacy-unavailable.mjs')}));builder.onResolve({filter:/legacy-local\.mjs$/},()=>({path:join(sourceDirectory,'integrations/host-adapters/opencode-stable/bridge/legacy-local-unavailable.mjs')}));}}]});
 const artifacts={[binary]:sha(await readFile(join(destination,binary)))},sources={},dependencies={},dependencyResolution={};
 for(const output of result.outputFiles){const name=relative(destination,output.path).replaceAll('\\','/');await writeFile(output.path,output.contents,{flag:'wx'});artifacts[name]=sha(output.contents);}
 for(const source of Object.keys(result.metafile.inputs)){
  if(source==='go-opencode-candidate.mjs')continue;
  if(source.replaceAll('\\','/').includes('/node_modules/')||source.startsWith('node_modules/'))throw Error('Unexpected bundled dependency source');
  sources[source]=sha(await readFile(resolve(sourceDirectory,source)));
 }
 for(const output of Object.values(result.metafile.outputs))for(const item of output.imports){if(!item.external||item.path.startsWith('node:')||item.path==='bun:sqlite')continue;const name=packageName(item.path);if(dependencies[name])continue;const selected=await dependencyVersion(name,result.metafile.inputs);dependencies[name]=selected.selected;dependencyResolution[name]=selected;}
 for(const file of await readdir(join(sourceDirectory,'go'),{recursive:true})){
  if(file.endsWith('.go')||file==='go.mod'||file==='go.sum')sources['go/'+file.replaceAll('\\','/')]=sha(await readFile(join(sourceDirectory,'go',file)));
 }
 const compact=await buildCompactApp({destination:join(destination,'dist')});
 for(const file of compact.inputs){const source=relative(sourceDirectory,resolve(file)).replaceAll('\\','/');if(!source.startsWith('../')&&!source.includes('/node_modules/')&&!source.startsWith('node_modules/'))sources[source]=sha(await readFile(resolve(file)));}
 for(const file of await readdir(join(destination,'dist')))artifacts['dist/'+file]=sha(await readFile(join(destination,'dist',file)));
 // The Go installer consumes the same static skills/host formats. It never
 // copies the Node setup/host-configs runtime as a replacement business core.
 async function candidateAsset(sourceName,outputName){
  const source=join(sourceDirectory,sourceName),info=await lstat(source);
  if(info.isSymbolicLink())throw Error('Candidate installation asset must be regular');
  if(info.isDirectory()){await mkdir(join(destination,outputName),{recursive:true});for(const name of await readdir(source))await candidateAsset(sourceName+'/'+name,outputName+'/'+name);return;}
  if(!info.isFile()||info.isSymbolicLink())throw Error('Candidate installation asset must be regular');
  const contents=await readFile(source);await mkdir(dirname(join(destination,outputName)),{recursive:true});await writeFile(join(destination,outputName),contents,{flag:'wx'});
  sources[sourceName]=sha(contents);artifacts[outputName]=sha(contents);
 }
 for(const[source,output]of [['integrations/native-v2/skills/galaxy','skills/galaxy'],['integrations/native-v2/codex','host-templates/codex'],['integrations/native-v2/host-capabilities.json','host-capabilities.json']])await candidateAsset(source,output);
 // The Go runtime resolves this fixed resource relative to os.Executable,
 // including when the Native candidate is nested inside a Go core candidate.
 // Copy here once so both callers hash and carry the same original bytes.
 const windowsNotificationHelper='notifications/windows-notify-icon.ps1';
 await candidateAsset('packages/galaxy-edge-mcp/src/native-v2/notifications/windows-notify-icon.ps1',windowsNotificationHelper);
 for(const[name,contents]of Object.entries({
  'README.md':'# Galaxy Go Native candidate\n\nThis is an incomplete local migration candidate. Start MCP with the included galaxy binary and the native subcommand, using an explicitly selected GALAXY_NATIVE_CONFIG. OpenCode retains opencode.js as its host UI adapter. No Node business core is bundled.\n\nKeep notifications/windows-notify-icon.ps1 beside the executable in its notifications subdirectory. It is the unchanged original Windows helper; the runtime uses the explicitly configured absolute PowerShell command. Linux retains its original Python helper embedded in Go and requires the selected Python executable (default /usr/bin/python3); no Node notification module is required. macOS requires an explicitly configured signed GalaxyNotifications.app executable; this candidate does not build, sign, install or automatically select an App. These resources do not enable notifications or establish platform acceptance.\n\nThe included skills and host formats retain their original tool references; use the runtime tool list to identify supported actions. Existing host-capabilities.json observations belong to their recorded runtime/version, not this Go candidate. Installation, platform acceptance and migration completion remain pending.\n',
  'HOSTS.md':'# Host configuration\n\nGo host configuration uses the included platform binary, args ["native"], and the explicit GALAXY_NATIVE_CONFIG path. The Go installer generates only the chosen host configuration. Static skills and host templates are included; historical host observations do not establish current Go acceptance.\n'
 })){await writeFile(join(destination,name),contents,{flag:'wx'});artifacts[name]=sha(contents);}
 for(const name of ['LICENSE','NOTICE'])await candidateAsset('integrations/native-v2/legal/'+name,name);
 sources['scripts/build-native-v2.mjs']=sha(await readFile(join(sourceDirectory,'scripts/build-native-v2.mjs')));
 const platformResources={windows:{helper:windowsNotificationHelper,command:'explicit-absolute-PowerShell'},linux:{helper:'embedded-original-Python',command:'configured-Python-or-/usr/bin/python3'},darwin:{helper:'externally-configured-signed-GalaxyNotifications.app',bundled:false},platformAcceptance:'pending'};
 const manifest={version:2,kind:'galaxy-native-go-local-candidate',component:'client',releaseId:version,backend:'go',target:{goos,goarch},compiler:compiler.trim(),builder:'esbuild '+esbuildVersion,mcp:{command:binary,args:['native']},hostPersistence:{command:binary,args:['host'],transport:'private-jsonl'},artifacts,dependencyResolution,sourceFiles:Object.keys(sources).length,platformResources,publicRelease:false,defaultInstallationChanged:false,migrationComplete:false,hostAcceptance:'pending',modelProvider:'user-host',containsPrivateKeys:false,containsConfiguredAuthority:false};
 const pkg={name:'@galaxy/native-go-candidate',version,private:true,type:'module',license:'Apache-2.0',engines:{node:'>=22.13.0'},exports:{'./opencode':'./opencode.js'},dependencies};
 for(const[name,value]of Object.entries({'package.json':pkg,'native-v2.json':manifest,'source-hashes.json':sources}))await writeFile(join(destination,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 return{destination,manifest,dependencies};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const input=process.argv.slice(2),options={goExecutable:process.env.GALAXY_BUILD_GO??'go'};
 if(input[0]&&!input[0].startsWith('--'))options.destination=input.shift();
 if(input[0]&&!input[0].startsWith('--'))options.sourceDirectory=input.shift();
 const flags={'--output':'destination','--source':'sourceDirectory','--go':'goExecutable','--version':'version','--goos':'goos','--goarch':'goarch'};
 while(input.length){const flag=input.shift();if(!flags[flag]||!input.length||input[0].startsWith('--'))throw Error('Usage: node scripts/build-native-v2.mjs ABS_NEW [ABS_SOURCE] [--go COMMAND_OR_ABS_GO] [--version VERSION] [--goos windows|linux|darwin] [--goarch amd64|arm64]');options[flags[flag]]=input.shift();}
 console.log(JSON.stringify(await buildGoNativeCandidate(options)));
}
