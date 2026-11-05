import {build,version as esbuildVersion} from 'esbuild';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,relative,join,isAbsolute,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {componentRelease,INITIAL_VERSION} from './release-identifiers.mjs';
import {buildCompactApp} from '../integrations/native-v2/compact-app/build.mjs';
import {collectGoNativeLicenses} from './go-native-licenses.mjs';
import {stageMacOSNotificationBundle} from '../integrations/native-v2/notifications/macos-helper/stage-bundle.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex');
const packageName=path=>path.startsWith('@')?path.split('/').slice(0,2).join('/'):path.split('/')[0];
// Native bundles have one dependency namespace. Reconcile these two observed
// local patch versions to the current Official/A2A lock; candidate HTTP/stdio
// checks validate the selected runtime. Future unreviewed differences fail.
const nativeReconciliation={jose:{selected:'6.2.12',inputs:['6.2.10','6.2.12']}};
async function dependencyVersion(name,inputs,sourceDirectory){
 const importers=Object.entries(inputs).filter(([,value])=>value.imports.some(i=>i.external&&packageName(i.path)===name)).map(([source])=>source);
 /** @type {Set<string>} */
 const versions=new Set();
 for(const source of importers.length?importers:['package.json']){
  let directory=dirname(resolve(sourceDirectory,source)),found=false;
  while(directory===resolve(sourceDirectory)||directory.startsWith(resolve(sourceDirectory)+sep)){
   try{const pkg=JSON.parse(await readFile(join(directory,'node_modules',name,'package.json'),'utf8'));
    if(pkg.name!==name)throw new Error('External native dependency identity differs');versions.add(pkg.version);found=true;break;
   }catch(error){if(error.code!=='ENOENT')throw error;}
   if(directory===resolve(sourceDirectory))break;directory=dirname(directory);
  }
  if(!found)throw new Error('Unresolved native dependency '+name+' imported by '+source);
 }
 const choice=nativeReconciliation[name];
 if(versions.size!==1&&(!choice||![...versions].every(v=>choice.inputs.includes(v))))throw new Error('Multiple native dependency versions require explicit reconciliation: '+name);
 return {selected:versions.size===1?[...versions][0]:choice.selected,observed:[...versions].sort((a,b)=>a<b?-1:a>b?1:0)};
}
// Normal source build entry for the Go Native candidate. It never changes a
// previously signed release, installed command, or host configuration.
export async function buildGoNativeCandidate({destination,sourceDirectory=root,version=INITIAL_VERSION,goExecutable='go',goos=process.platform==='win32'?'windows':process.platform,goarch=process.arch==='x64'?'amd64':process.arch,macOSNotificationApp}){
 if(!isAbsolute(destination)||!isAbsolute(sourceDirectory)||typeof goExecutable!=='string'||!goExecutable.trim())throw Error('Absolute candidate/source and nonempty Go command required');
 if(!['windows','linux','darwin'].includes(goos)||!['amd64','arm64'].includes(goarch))throw Error('Unsupported Go Native candidate target');
 if(macOSNotificationApp&&goos!=='darwin')throw Error('The macOS notification app belongs to a darwin candidate');
 componentRelease('client',version);
 const binary=goos==='windows'?'galaxy.exe':'galaxy';
 // mkdir without recursive/exist-ok protects every existing release directory.
 await mkdir(destination);
 const run=promisify(execFile);
 const {stdout:compiler}=await run(goExecutable,['version'],{cwd:join(sourceDirectory,'go'),windowsHide:true});
 const goLicenses=await collectGoNativeLicenses({sourceDirectory,destination,goExecutable,goos,goarch});
 await run(goExecutable,['build','-mod=readonly','-trimpath','-buildvcs=false','-o',join(destination,binary),'./cmd/galaxy'],{cwd:join(sourceDirectory,'go'),windowsHide:true,env:{...process.env,GOOS:goos,GOARCH:goarch,CGO_ENABLED:'0',GOTOOLCHAIN:'local',GOFLAGS:'-mod=readonly'}});
 const artifacts={[binary]:sha(await readFile(join(destination,binary)))},sources={...goLicenses.sourceHashes},dependencies={},dependencyResolution={};
 const inputs={},externalImports=new Set();
 for(const [file,source,factory] of [['opencode.js','native-galaxy.tui.ts','createNativeGalaxyPlugin'],['opencode-v2.js','native-galaxy-v2.tui.ts','createNativeGalaxyPluginV2'],['opencode-v2-server.js','native-galaxy-v2.server.ts','createNativeGalaxyServerPluginV2']]){
  const virtual=`go-${file}-candidate.mjs`;
  const entry=`import {fileURLToPath} from 'node:url';import {${factory} as createPlugin} from './integrations/host-adapters/opencode-stable/${source}';const executable=fileURLToPath(new URL('./${binary}',import.meta.url));export function ${factory}(options={}){return createPlugin({...options,backend:'go',executable:options.executable??executable});}export default ${factory}();`;
  const result=await build({absWorkingDir:sourceDirectory,stdin:{contents:entry,resolveDir:sourceDirectory,sourcefile:virtual,loader:'js'},outfile:join(destination,file),bundle:true,splitting:false,platform:'node',format:'esm',target:'node22',packages:'external',external:['bun:sqlite','@opencode/plugin/tui','solid-js','solid-js/*'],metafile:true,write:false,sourcemap:false});
  for(const output of result.outputFiles){const name=relative(destination,output.path).replaceAll('\\','/');await writeFile(output.path,output.contents,{flag:'wx'});artifacts[name]=sha(output.contents);}
  for(const [name,info] of Object.entries(result.metafile.inputs)){if(name!==virtual){if(inputs[name])inputs[name].imports.push(...info.imports);else inputs[name]={...info,imports:[...info.imports]};}}
  for(const output of Object.values(result.metafile.outputs))for(const item of output.imports)if(item.external&&!item.path.startsWith('node:')&&item.path!=='bun:sqlite'&&item.path!=='@opencode/plugin/tui'&&!(file==='opencode-v2-server.js'&&item.path==='@opencode/plugin')&&!(file==='opencode-v2.js'&&packageName(item.path)==='solid-js'))externalImports.add(packageName(item.path));
 }
 for(const source of Object.keys(inputs)){
  if(source.replaceAll('\\','/').includes('/node_modules/')||source.startsWith('node_modules/'))throw Error('Unexpected bundled dependency source');
  sources[source]=sha(await readFile(resolve(sourceDirectory,source)));
 }
 for(const name of externalImports){const selected=await dependencyVersion(name,inputs,sourceDirectory);dependencies[name]=selected.selected;dependencyResolution[name]=selected;}
 const compact=await buildCompactApp({destination:join(destination,'dist')});
 for(const file of compact.inputs){const source=relative(sourceDirectory,resolve(file)).replaceAll('\\','/');if(!source.startsWith('../')&&!source.includes('/node_modules/')&&!source.startsWith('node_modules/'))sources[source]=sha(await readFile(resolve(file)));}
 for(const file of await readdir(join(destination,'dist')))artifacts['dist/'+file]=sha(await readFile(join(destination,'dist',file)));
 // The Go installer consumes the same static skills/host formats. It never
 // copies the Node setup/host-configs runtime as a replacement business core.
 async function candidateAsset(sourceName,outputName){
  if(sourceName.startsWith('integrations/native-v2/skills/galaxy/')){
   const parts=sourceName.slice('integrations/native-v2/skills/galaxy/'.length).split('/'),name=parts.at(-1);
   if(parts.some(part=>['__pycache__','.pytest_cache','.git','node_modules'].includes(part))||name==='.DS_Store'||/\.(?:pyc|pyo|tmp|swp)$/i.test(name)||name.endsWith('~'))return;
  }
  const source=join(sourceDirectory,sourceName),info=await lstat(source);
  if(info.isSymbolicLink())throw Error('Candidate installation asset must be regular');
  if(info.isDirectory()){await mkdir(join(destination,outputName),{recursive:true});for(const name of await readdir(source))await candidateAsset(sourceName+'/'+name,outputName+'/'+name);return;}
  if(!info.isFile()||info.isSymbolicLink())throw Error('Candidate installation asset must be regular');
  const contents=await readFile(source);await mkdir(dirname(join(destination,outputName)),{recursive:true});await writeFile(join(destination,outputName),contents,{flag:'wx'});
  sources[sourceName]=sha(contents);artifacts[outputName]=sha(contents);
 }
 for(const[source,output]of [['integrations/native-v2/skills/galaxy','skills/galaxy'],['integrations/native-v2/codex','host-templates/codex'],['integrations/native-v2/host-capabilities.json','host-capabilities.json'],['integrations/host-adapters/shared','host-adapters/shared'],['integrations/host-adapters/codex/hook.mjs','host-adapters/codex/hook.mjs'],['integrations/host-adapters/claude-code/hook.mjs','host-adapters/claude-code/hook.mjs'],['integrations/host-adapters/hermes/plugin.yaml','host-adapters/hermes/plugin.yaml'],['integrations/host-adapters/hermes/__init__.py','host-adapters/hermes/__init__.py'],['integrations/host-adapters/deepseek-harness/index.mjs','host-adapters/deepseek-harness/index.mjs'],['integrations/host-adapters/opencode-stable/bridge/child-rpc.mjs','host-adapters/opencode-stable/bridge/child-rpc.mjs']])await candidateAsset(source,output);
 // The Go runtime resolves this fixed resource relative to os.Executable,
 // including when the Native candidate is nested inside a Go core candidate.
 // Copy here once so both callers hash and carry the same original bytes.
 const windowsNotificationHelper='notifications/windows-notify-icon.ps1';
 await candidateAsset('integrations/native-v2/notifications/windows-notify-icon.ps1',windowsNotificationHelper);
 for(const[name,contents]of Object.entries({
  'README.md':'# Galaxy Go Native candidate\n\nRun the included galaxy binary (galaxy.exe on Windows) with install to configure the current user and selected host; use --host when the current host cannot be identified. The same installer supports update, repair and uninstall, preserving existing data. Use --config or GALAXY_NATIVE_CONFIG for an existing service; without one, installation uses local-only mode. The included native and integration-mcp commands connect to the shared Go core. OpenCode uses the host-compatible opencode.js or opencode-v2.js UI adapter; no Node business core is bundled.\n\nKeep notifications/windows-notify-icon.ps1 beside the executable in its notifications subdirectory. It is the unchanged original Windows helper; the runtime uses the explicitly configured absolute PowerShell command. Linux retains its original Python helper embedded in Go and requires the selected Python executable (default /usr/bin/python3); no Node notification module is required. macOS uses an explicitly configured GalaxyNotifications.app executable; an optional prebuilt bundle can be staged without claiming signature, notarization or OS permission verification. This candidate does not sign, install or automatically select an App. These resources do not enable notifications or establish platform acceptance.\n\nThe included skills and host formats retain their original tool references; use the runtime tool list to identify supported actions. The host-capabilities.json file describes host formats and source adapters; it is not a runtime acceptance record. Real host and platform acceptance and migration completion remain separate; building this candidate does not change an installed host.\n',
  'HOSTS.md':'# Host configuration\n\nService Native uses the included platform binary, args ["native"], and the explicit GALAXY_NATIVE_CONFIG path. Local-only Integration uses args ["integration-mcp", "--data-dir", "ABSOLUTE_PATH"] without a service configuration; it does not expose service tools or start uploads. OpenCode uses a thin host adapter and a private Go host channel for local persistence; model calls remain with the selected host SDK. The Go installer generates only the chosen host configuration. Static skills and host templates are included; historical host observations do not establish current Go acceptance.\n'
 })){await writeFile(join(destination,name),contents,{flag:'wx'});artifacts[name]=sha(contents);}
 for(const name of ['LICENSE','NOTICE'])await candidateAsset('integrations/native-v2/legal/'+name,name);
 for(const [name,digest] of Object.entries(goLicenses.files))artifacts[name]=digest;
 sources['scripts/build-native-v2.mjs']=sha(await readFile(join(sourceDirectory,'scripts/build-native-v2.mjs')));
 sources['scripts/go-native-licenses.mjs']=sha(await readFile(join(sourceDirectory,'scripts/go-native-licenses.mjs')));
 sources['integrations/native-v2/notifications/macos-helper/stage-bundle.mjs']=sha(await readFile(join(sourceDirectory,'integrations/native-v2/notifications/macos-helper/stage-bundle.mjs')));
 const platformResources={windows:{helper:windowsNotificationHelper,command:'explicit-absolute-PowerShell'},linux:{helper:'embedded-original-Python',command:'configured-Python-or-/usr/bin/python3'},darwin:{helper:'externally-configured-signed-GalaxyNotifications.app',bundled:false},platformAcceptance:'pending'};
 if(macOSNotificationApp){
  const {artifacts:helperArtifacts,...helper}=await stageMacOSNotificationBundle({source:macOSNotificationApp,destination});
  Object.assign(artifacts,helperArtifacts);
  platformResources.darwin={...helper,bundled:true};
  const readmePath=join(destination,'README.md');
  const readme=(await readFile(readmePath,'utf8'))+'\nA prebuilt notifications/GalaxyNotifications.app is included in this candidate. Configure its installed absolute command when using notifications. Its original bundle bytes are preserved; resource presence does not establish signature, notarization or desktop acceptance.\n';
  await writeFile(readmePath,readme);artifacts['README.md']=sha(readme);
 }
 const manifest={version:2,kind:'galaxy-native-go-local-candidate',component:'client',releaseId:version,backend:'go',target:{goos,goarch},compiler:compiler.trim(),builder:'esbuild '+esbuildVersion,mcp:{command:binary,args:['native']},hostPersistence:{command:binary,args:['host'],transport:'private-jsonl'},artifacts,dependencyResolution,sourceFiles:Object.keys(sources).length,platformResources,publicRelease:false,defaultInstallationChanged:false,migrationComplete:false,hostAcceptance:'pending',modelProvider:'user-host',containsPrivateKeys:false,containsConfiguredAuthority:false};
 const pkg={name:'@galaxy/native-go-candidate',version,private:true,type:'module',license:'Apache-2.0',engines:{node:'>=22.13.0'},exports:{'./opencode':'./opencode.js'},dependencies};
 for(const[name,value]of Object.entries({'package.json':pkg,'native-v2.json':manifest,'source-hashes.json':sources}))await writeFile(join(destination,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 return{destination,manifest,dependencies};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const input=process.argv.slice(2),options={goExecutable:process.env.GALAXY_BUILD_GO??'go'};
 if(input[0]&&!input[0].startsWith('--'))options.destination=input.shift();
 if(input[0]&&!input[0].startsWith('--'))options.sourceDirectory=input.shift();
 const flags={'--output':'destination','--source':'sourceDirectory','--go':'goExecutable','--version':'version','--goos':'goos','--goarch':'goarch','--macos-notification-app':'macOSNotificationApp'};
 while(input.length){const flag=input.shift();if(!flags[flag]||!input.length||input[0].startsWith('--'))throw Error('Usage: node scripts/build-native-v2.mjs ABS_NEW [ABS_SOURCE] [--go COMMAND_OR_ABS_GO] [--version VERSION] [--goos windows|linux|darwin] [--goarch amd64|arm64] [--macos-notification-app ABS_APP]');options[flags[flag]]=input.shift();}
 console.log(JSON.stringify(await buildGoNativeCandidate(options)));
}
