import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const label=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(v);
const platform={win32:'windows',linux:'linux',darwin:'darwin'},architecture={x64:'amd64',arm64:'arm64'};
const commands=['galaxy-api','galaxy-worker','galaxy-information-worker','galaxy-publisher','galaxy-migrate','galaxy-lifecycle'];
// go emits a stream of standalone JSON objects. Objects begin at column zero;
// nested object members are indented, including arbitrary quoted braces.
const jsonStream=text=>text.trim()?text.trim().split(/\r?\n(?=\{)/).map(value=>JSON.parse(value)):[];

// Build construction only. Release mode selects the deployable Go format; it
// never installs services, migrates databases, or asserts platform acceptance.
export async function buildGoCore({destination,sourceDirectory=root,goExecutable='go',releaseId,configurationVersion,goos=platform[process.platform],goarch=architecture[process.arch],includeNative=true,mode='candidate'}={}){
 if(![destination,sourceDirectory].every(v=>typeof v==='string'&&isAbsolute(v))||typeof goExecutable!=='string'||!goExecutable.trim()||!label(releaseId)||!label(configurationVersion))throw Error('Absolute new output/source, nonempty Go command and explicit release/configuration labels required');
 if(!['windows','linux','darwin'].includes(goos)||!['amd64','arm64'].includes(goarch))throw Error('Unsupported Go candidate target');
 if(!['candidate','release'].includes(mode))throw Error('Build mode must be candidate or release.');
 const cwd=join(sourceDirectory,'go'),env={...process.env,GOOS:goos,GOARCH:goarch,CGO_ENABLED:'0',GOTOOLCHAIN:'local',GOFLAGS:'-mod=readonly'};
 const invoke=args=>run(goExecutable,args,{cwd,env,windowsHide:true,maxBuffer:64*1024*1024});
 const {stdout:compiler}=await invoke(['version']);
 // New directory only; partial failed candidates remain visible for diagnosis.
 await mkdir(destination,{mode:0o700});
 const entries={};
 for(const command of commands){
  const binary=command+(goos==='windows'?'.exe':'');
  await invoke(['build','-mod=readonly','-trimpath','-buildvcs=false','-o',join(destination,binary),'./cmd/'+command]);
  entries[command]=binary;
 }
 async function asset(source,target){
  const stat=await lstat(source);if(stat.isSymbolicLink())throw Error('Candidate asset symlink rejected');
  if(stat.isDirectory()){for(const name of (await readdir(source)).sort())await asset(join(source,name),join(target,name));return;}
  if(!stat.isFile())throw Error('Candidate asset must be regular');
  await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(source),{flag:'wx'});
 }
 await asset(join(sourceDirectory,'packages/galaxy-official/public-docs.json'),join(destination,'public-docs.json'));
 await asset(join(sourceDirectory,'go/deploy'),join(destination,'deploy'));
 for(const name of ['LICENSE','NOTICE'])await asset(join(sourceDirectory,name),join(destination,name));
 let native=null;
 if(includeNative){
  const {buildGoNativeCandidate}=await import('./build-native-v2.mjs');
  // The same standalone Native builder includes compact Apps, host adapter,
  // templates, original platform resources and Native license. Resources are
  // copied only by that builder, before its manifest and this inventory.
  const built=await buildGoNativeCandidate({destination:join(destination,'native'),sourceDirectory,goExecutable,goos,goarch});
  native=built.manifest;
  entries.native='native/'+(goos==='windows'?'galaxy.exe':'galaxy');
 }
 // Galaxy-owned source follows the root Apache-2.0 license and notice.
 // Dependency texts retain their own original licenses in the inventory.
 const packages=jsonStream((await invoke(['list','-mod=readonly','-buildvcs=false','-deps','-json',...commands.map(c=>'./cmd/'+c),...(includeNative?['./cmd/galaxy']:[])])).stdout);
 const modules=new Map();for(const pkg of packages){const m=pkg.Module;if(m&&!m.Main)modules.set(m.Path+'@'+m.Version,m);}
 const licenses=[],missing=[];
 async function legalFiles(directory,prefix=''){
  const found=[];
  for(const item of await readdir(directory,{withFileTypes:true})){
   if(item.isSymbolicLink()||item.name==='.git'||item.name==='testdata'||item.name==='node_modules')continue;
   const name=prefix?prefix+'/'+item.name:item.name;
   if(item.isDirectory())found.push(...await legalFiles(join(directory,item.name),name));
   else if(item.isFile()&&/^(licen[sc]e|copying|notice|copyright)([._-].*)?$/i.test(item.name))found.push(name);
  }
  return found;
 }
 for(const [id,module] of [...modules].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  const selected=module.Replace??module;
  if(!selected.Dir){missing.push(id);continue;}
  const names=await legalFiles(selected.Dir),texts=[];
  for(const name of names){const target='third-party-licenses/'+id+'/'+name;await asset(join(selected.Dir,name),join(destination,target));texts.push(target);}
  licenses.push({module:module.Path,version:module.Version,sum:module.Sum??null,replacement:module.Replace?{path:selected.Path,version:selected.Version??null}:null,files:texts});
  if(!names.length)missing.push(id);
 }
 const goroot=(await invoke(['env','GOROOT'])).stdout.trim();
 await asset(join(goroot,'LICENSE'),join(destination,'third-party-licenses/Go/LICENSE'));
 await writeFile(join(destination,'go-dependency-licenses.json'),JSON.stringify({version:1,compiler:compiler.trim(),modules:licenses,missing},null,2)+'\n',{flag:'wx'});
 await writeFile(join(destination,'BUILD_INFO.txt'),`Galaxy Go core ${mode==='release'?'release artifact':'local migration candidate'}\n\nBuilding this artifact does not create a GitHub Release, install or activate services, provision databases, complete the migration, or attest target-platform acceptance. Galaxy-owned source is licensed under Apache-2.0 as provided in LICENSE and NOTICE copied from the source root. Third-party dependency licenses retain their original scope and texts under third-party-licenses. No configuration, credentials, private keys or user data are included.\n`,{flag:'wx'});
 const files={};
 async function inventory(directory,prefix=''){
  for(const item of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
   const name=prefix?prefix+'/'+item.name:item.name;
   if(item.isSymbolicLink())throw Error('Candidate output symlink rejected');
   if(item.isDirectory())await inventory(join(directory,item.name),name);
   else if(item.isFile()){const bytes=await readFile(join(directory,item.name));files[name]={bytes:bytes.length,sha256:sha(bytes)};}
  }
 }
 await inventory(destination);
 const manifest={version:1,kind:mode==='release'?'galaxy-go-core-release':'galaxy-go-core-local-candidate',mode,component:'hub',releaseId,configurationVersion,createdAt:new Date().toISOString(),backend:'go',compiler:compiler.trim(),target:{goos,goarch,cgo:false},entries,files,
  embeddedResources:['Go mail templates','Go SQL/JSON resources','Original business schema history and role scripts','River technical migrations'],
  schema:{businessMigrations:'Original schema history embedded; galaxy-migrate business-up is explicit',startupMigrates:false,queueAdoption:'explicit-original-business-identities'},
  native:native?{manifest:'native/native-v2.json',releaseId:native.releaseId,platformResources:native.platformResources,migrationComplete:false,hostAcceptance:'pending'}:null,
  limitations:[...(mode==='candidate'?['Local migration candidate']:[]),'Go binaries use their pinned Go artifact manifest; the old Node service-release deployment/inspection format is separate','Business schema, role provisioning and queue cutover remain explicit administrative operations','Building does not establish production/platform acceptance, migrate databases, replace installed commands or activate services',...(includeNative?['Native retains separately required host/UI dependencies declared by its own package']:[]),...(missing.length?['Dependency license texts missing for: '+missing.join(', ')]:[])],
  publicRelease:false,deployed:false,defaultInstallationChanged:false,migrationComplete:false,containsConfiguredAuthority:false};
 const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(join(destination,'go-core-artifact.json'),bytes,{flag:'wx'});
 return{destination,releaseId,kind:manifest.kind,mode,manifestSha256:sha(bytes),files:Object.keys(files).length,entries,missingDependencyLicenses:missing,deployed:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),options={};
 while(args.length){const key=args.shift();if(key==='--without-native'){options.includeNative=false;continue;}const names={'--output':'destination','--source':'sourceDirectory','--go':'goExecutable','--release':'releaseId','--configuration-version':'configurationVersion','--goos':'goos','--goarch':'goarch','--mode':'mode'};if(!names[key]||!args.length||args[0].startsWith('--'))throw Error('Usage: node scripts/build-go-core.mjs --output ABS_NEW --release LABEL --configuration-version LABEL [--go COMMAND_OR_ABS_GO] [--source ABS_SOURCE] [--goos linux|windows|darwin] [--goarch amd64|arm64] [--without-native] [--mode candidate|release]');options[names[key]]=args.shift();}
 console.log(JSON.stringify(await buildGoCore(options)));
}
