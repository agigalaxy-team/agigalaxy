import {readFile,writeFile,mkdir,lstat,readdir,rm} from 'node:fs/promises';
import {resolve,relative,join,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {signRelease} from '../packages/galaxy-contracts/src/release-artifact.mjs';
import {verifyNativeLicenseNotices} from './native-license-notices.mjs';
import {parseComponentRelease} from './release-identifiers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex'),json=v=>JSON.stringify(v,null,2)+'\n';
const fail=m=>{throw Error(m);};
function inside(base,name){const path=resolve(base,name),r=relative(base,path);if(!r||isAbsolute(r)||r==='..'||r.startsWith('..'+sep))fail('Invalid candidate member');return path;}
async function bytes(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())fail('Regular candidate file required');return readFile(path);}
async function object(path){return JSON.parse(await bytes(path));}
function tar(command,args){return execFileSync(command,args,{windowsHide:true,timeout:120000,maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});}
export async function inspectNativeClientCandidate({source,sourceDirectory=root}){
 if(!isAbsolute(source)||!isAbsolute(sourceDirectory))fail('Absolute candidate and source required');
 const packageJson=await object(join(source,'package.json')),manifest=await object(join(source,'native-v2.json')),
  sourceBytes=await bytes(join(source,'source-hashes.json')),hashes=JSON.parse(sourceBytes),lockBytes=await bytes(join(source,'package-lock.json')),lock=JSON.parse(lockBytes);
 if(packageJson.name!=='@galaxy/native-go-candidate'||!parseComponentRelease(packageJson.version)||packageJson.private!==true||
  !isDeepStrictEqual(packageJson.exports,{'./opencode':'./opencode.js'})||!isDeepStrictEqual(packageJson.dependencies,lock.packages?.['']?.dependencies)||
  manifest.kind!=='galaxy-native-go-local-candidate'||manifest.backend!=='go'||manifest.releaseId!==packageJson.version||
  manifest.containsPrivateKeys!==false||manifest.containsConfiguredAuthority!==false||manifest.sourceFiles!==Object.keys(hashes).length||
  !['windows','linux','darwin'].includes(manifest.target?.goos)||!['amd64','arm64'].includes(manifest.target?.goarch)||
  manifest.mcp?.command!==(manifest.target.goos==='windows'?'galaxy.exe':'galaxy')||!isDeepStrictEqual(manifest.mcp.args,['native']))fail('Go Native candidate metadata differs');
 for(const[name,digest]of Object.entries(hashes))if(!/^[a-f0-9]{64}$/.test(digest)||sha(await bytes(inside(sourceDirectory,name)))!==digest)fail('Go Native source changed: '+name);
 for(const[name,digest]of Object.entries(manifest.artifacts))if(!/^[a-f0-9]{64}$/.test(digest)||sha(await bytes(inside(source,name)))!==digest)fail('Go Native artifact differs: '+name);
 for(const required of [manifest.mcp.command,'opencode.js','HOSTS.md','README.md','skills/galaxy/SKILL.md','go-dependency-licenses.json'])if(!manifest.artifacts[required])fail('Candidate artifact missing: '+required);
 const legal=await object(join(source,'go-dependency-licenses.json'));if(legal.scope!=='standalone-native-go-binary'||!Array.isArray(legal.missing)||legal.missing.length)fail('Go dependency license texts missing');
 for(const[name,version]of Object.entries(packageJson.dependencies))if((await object(join(source,'node_modules',name,'package.json'))).version!==version||lock.packages?.['node_modules/'+name]?.version!==version)fail('Native dependency differs: '+name);
 await verifyNativeLicenseNotices({candidate:source});
 return{packageJson,manifest,sourceBytes,lockBytes};
}
async function members(source){const files={};async function walk(dir,prefix=''){
 for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  const name=prefix?prefix+'/'+entry.name:entry.name;if(/[\r\n]/.test(name))fail('Invalid archive member name');if(name==='node_modules/.bin'||name==='node_modules/.package-lock.json')continue;
  if(entry.isSymbolicLink())fail('Symlink package member forbidden: '+name);
  if(entry.isDirectory())await walk(join(dir,entry.name),name);else if(entry.isFile())files[name]=sha(await bytes(join(dir,entry.name)));else fail('Unsupported package member');
 }}await walk(source);return files;}
function protocolReport(report){if(report.version!==1||report.profile!=='galaxy-native-go/1'||report.scope!=='candidate-package-integrity'||report.status!=='integrity-verified'||report.actualHostAcceptance!==false||report.humanAcceptance!==false)fail('Invalid Go candidate report');return report;}
// Packaging checks exact archive bytes. It deliberately makes no protocol or
// host-acceptance assertion and never installs, signs or publishes.
export async function prepareNativeClientRelease({source,destination,tarExecutable='tar',sourceDirectory=root}){
 if(!isAbsolute(source)||!isAbsolute(destination)||!isAbsolute(sourceDirectory)||typeof tarExecutable!=='string'||!tarExecutable)fail('Absolute candidate/output/source required');
 const candidate=await inspectNativeClientCandidate({source,sourceDirectory}),files=await members(source);
 await mkdir(destination);const filename=`galaxy-native-go-${candidate.packageJson.version}.tgz`,archive=join(destination,filename),names=Object.keys(files);
 const list=join(destination,'archive-members.txt'),staging=join(destination,'.archive-check');
 await writeFile(list,names.join('\n')+'\n',{flag:'wx'});
 try {
  tar(tarExecutable,['-czf',archive,'-C',source,'-T',list]);
  const entries=tar(tarExecutable,['-tf',archive]).toString('utf8').trim().split(/\r?\n/);if(!isDeepStrictEqual(entries,names))fail('Archive member list differs');
  if(tar(tarExecutable,['-tvf',archive]).toString('utf8').trim().split(/\r?\n/).some(line=>!line.startsWith('-')))fail('Archive contains non-regular members');
  await mkdir(staging);tar(tarExecutable,['-xf',archive,'-C',staging]);
  for(const[name,digest]of Object.entries(files))if(sha(await bytes(inside(staging,name)))!==digest)fail('Archive bytes differ: '+name);
 } finally {await rm(list,{force:true});await rm(staging,{recursive:true,force:true});}
 await inspectNativeClientCandidate({source,sourceDirectory});for(const[name,digest]of Object.entries(files))if(sha(await bytes(inside(source,name)))!==digest)fail('Candidate changed during packaging');
 const artifact=await bytes(archive),sourceSha256=sha(candidate.sourceBytes),artifactsSha256=sha(JSON.stringify(files));
 const report=protocolReport({version:1,profile:'galaxy-native-go/1',scope:'candidate-package-integrity',status:'integrity-verified',checkedAt:new Date().toISOString(),packageSha256:sha(artifact),sourceSha256,artifactsSha256,actualHostAcceptance:false,humanAcceptance:false,protocolAcceptance:'not-tested-by-packaging'});
 const packageMetadata={name:candidate.packageJson.name,version:candidate.packageJson.version,filename,sha256:sha(artifact),bytes:artifact.length,exports:Object.keys(candidate.packageJson.exports),dependencies:candidate.packageJson.dependencies,lockSha256:sha(candidate.lockBytes),sourceHashesSha256:sourceSha256};
 const reportBytes=Buffer.from(json(report));for(const[name,value]of Object.entries({'protocol-report.json':reportBytes,'package-files.json':json(files),'package-metadata.json':json(packageMetadata),'source-hashes.json':candidate.sourceBytes,'package-lock.json':candidate.lockBytes}))await writeFile(join(destination,name),value,{flag:'wx'});
 return{destination,package:packageMetadata,protocolAcceptance:{profile:report.profile,scope:report.scope,reportSha256:sha(reportBytes),sourceSha256,artifactsSha256,actualHostAcceptance:false},publicationReady:false};
}
// Explicit caller-supplied signing only; no credential discovery or publication.
export async function createNativeClientRelease({preparedDirectory,publisher,purpose='release-candidate',privateKey,kid,now=Math.floor(Date.now()/1000),lifetime=86400}){
 if(!isAbsolute(preparedDirectory))fail('Absolute prepared directory required');
 const pkg=await object(join(preparedDirectory,'package-metadata.json')),reportBytes=await bytes(join(preparedDirectory,'protocol-report.json')),report=protocolReport(JSON.parse(reportBytes));
 if(pkg.name!=='@galaxy/native-go-candidate'||!parseComponentRelease(pkg.version)||pkg.filename!==`galaxy-native-go-${pkg.version}.tgz`)fail('Go Native package mismatch');
 const artifact=await bytes(inside(preparedDirectory,pkg.filename)),files=await object(join(preparedDirectory,'package-files.json')),sources=await bytes(join(preparedDirectory,'source-hashes.json')),lockBytes=await bytes(join(preparedDirectory,'package-lock.json')),lock=JSON.parse(lockBytes);
 if(sha(artifact)!==pkg.sha256||artifact.length!==pkg.bytes||report.packageSha256!==pkg.sha256||sha(sources)!==pkg.sourceHashesSha256||report.sourceSha256!==sha(sources)||report.artifactsSha256!==sha(JSON.stringify(files))||pkg.lockSha256!==sha(lockBytes)||!isDeepStrictEqual(lock.packages?.['']?.dependencies,pkg.dependencies))fail('Prepared Go Native bytes differ');
 const manifest={version:1,kind:'galaxy-native-go-release',publisher,purpose,issuedAt:now,expiresAt:now+lifetime,package:pkg,protocolAcceptance:{profile:report.profile,scope:report.scope,reportSha256:sha(reportBytes),sourceSha256:report.sourceSha256,artifactsSha256:report.artifactsSha256,actualHostAcceptance:false}};
 return{manifest,signed:await signRelease(manifest,{privateKey,kid}),reportBytes,artifact};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await prepareNativeClientRelease({source:process.argv[2],destination:process.argv[3],tarExecutable:process.argv[4]??'tar',sourceDirectory:process.argv[5]??root})));
