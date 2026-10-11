import {build,version as esbuildVersion} from 'esbuild';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve,relative,join,isAbsolute,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {componentRelease,INITIAL_VERSION} from './release-identifiers.mjs';
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
  if(!found)throw new Error('Unresolved native dependency '+name);
 }
 const choice=nativeReconciliation[name];
 if(versions.size!==1&&(!choice||![...versions].every(v=>choice.inputs.includes(v))))throw new Error('Multiple native dependency versions require explicit reconciliation: '+name);
 return {selected:versions.size===1?[...versions][0]:choice.selected,observed:[...versions].sort((a,b)=>a<b?-1:a>b?1:0)};
}
export async function buildNativeV2({destination,version=INITIAL_VERSION,sourceDirectory=root}){
 if(!isAbsolute(destination)||!isAbsolute(sourceDirectory))throw new Error('Absolute new candidate and source required');
 componentRelease('client',version);
 const result=await build({absWorkingDir:sourceDirectory,entryPoints:{galaxy:'packages/galaxy-edge-mcp/src/native-v2-entry.mjs',runtime:'packages/galaxy-edge-mcp/src/native-v2/runtime.mjs',server:'packages/galaxy-edge-mcp/src/native-v2/server.mjs'},outdir:destination,
  bundle:true,splitting:true,platform:'node',format:'esm',target:'node22',packages:'external',external:['bun:sqlite'],metafile:true,write:false,sourcemap:false});
 const names=new Set();for(const output of Object.values(result.metafile.outputs))for(const i of output.imports)if(i.external&&!i.path.startsWith('node:')&&i.path!=='bun:sqlite')names.add(i.path.startsWith('@')?i.path.split('/').slice(0,2).join('/'):i.path.split('/')[0]);
 const dependencies={},dependencyResolution={};for(const name of names){const entry=await dependencyVersion(name,result.metafile.inputs);dependencies[name]=entry.selected;dependencyResolution[name]=entry;}
 const sources={};for(const source of Object.keys(result.metafile.inputs)){
  if(source.replaceAll('\\','/').includes('/node_modules/')||source.startsWith('node_modules/'))throw new Error('Bundled third-party source requires a separate license inventory profile');
  sources[source]=sha(await readFile(join(sourceDirectory,source)));}
 const notificationHelper='packages/galaxy-edge-mcp/src/native-v2/notifications/windows-notify-icon.ps1';
 const helperBytes=await readFile(join(sourceDirectory,notificationHelper));sources[notificationHelper]=sha(helperBytes);
 await mkdir(destination);const artifacts={};for(const output of result.outputFiles){const name=relative(destination,output.path).replaceAll('\\','/');await writeFile(output.path,output.contents,{flag:'wx'});artifacts[name]=sha(output.contents);}
 await writeFile(join(destination,'windows-notify-icon.ps1'),helperBytes,{flag:'wx'});artifacts['windows-notify-icon.ps1']=sha(helperBytes);
 const manifest={version:2,kind:'galaxy-native-v2-local-candidate',component:'client',releaseId:version,builder:'esbuild '+esbuildVersion,sourceFiles:Object.keys(sources).length,artifacts,dependencyResolution,
  containsPrivateKeys:false,containsConfiguredAuthority:false,sourceRepositoryRequiredAtRuntime:false,publicRelease:false,actualEightHostAcceptance:'pending',embeddedUi:'unverified',modelProvider:'user-host'};
 const pkg={name:'@galaxy/native-client',version,private:true,license:'Apache-2.0',type:'module',engines:{node:'>=22.13.0'},scripts:{start:'node galaxy.js'},exports:{'./runtime':'./runtime.js','./server':'./server.js'},files:['*.js','*.mjs','windows-notify-icon.ps1','dist','skills','host-templates','host-capabilities.json','native-v2.json','source-hashes.json','README.md','HOSTS.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','license-inventory.json','third-party-licenses'],dependencies};
 for(const[name,value]of Object.entries({'package.json':pkg,'native-v2.json':manifest,'source-hashes.json':sources}))await writeFile(join(destination,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 await cp(join(sourceDirectory,'integrations/native-v2/skills'),join(destination,'skills'),{recursive:true,errorOnExist:true});
 await cp(join(sourceDirectory,'docs/native-client-v2.md'),join(destination,'README.md'),{errorOnExist:true});
 await cp(join(sourceDirectory,'docs/native-client-hosts-v2.md'),join(destination,'HOSTS.md'),{errorOnExist:true});
 await cp(join(sourceDirectory,'integrations/native-v2/codex'),join(destination,'host-templates/codex'),{recursive:true,errorOnExist:true});
 await cp(join(sourceDirectory,'integrations/native-v2/compact-app/dist'),join(destination,'dist'),{recursive:true,errorOnExist:true});
 for(const name of ['host-configs.mjs','host-capabilities.json','prepare-service-config.mjs'])await cp(join(sourceDirectory,'integrations/native-v2',name),join(destination,name),{errorOnExist:true});
 for(const name of ['LICENSE','NOTICE'])await cp(join(sourceDirectory,'integrations/native-v2/legal',name),join(destination,name),{errorOnExist:true});
 return{destination,manifest,dependencies};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildNativeV2({destination:process.argv[2],sourceDirectory:process.argv[3]??root})));
