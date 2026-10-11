import {readFile,writeFile,mkdir,lstat,readdir,rm} from 'node:fs/promises';
import {resolve,relative,join,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {signRelease} from '../packages/galaxy-official/src/release-artifact.mjs';
import {verifyNativeLicenseNotices} from './native-license-notices.mjs';
import {parseComponentRelease} from './release-identifiers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,null,2)+'\n';
const suites=['packages/galaxy-official/test/native-client-v2.test.mjs','packages/galaxy-edge-mcp/test/native-v2-stdio.test.mjs'];
const originalExports={'./runtime':'./runtime.js','./server':'./server.js'};
const openCodeExports={...originalExports,'./opencode':'./opencode.js'};
const copiedHelpers=['host-configs.mjs','host-capabilities.json','prepare-service-config.mjs','setup.mjs'];
const fail=message=>{throw new Error(message);};
function inside(directory,name){const path=resolve(directory,name),r=relative(directory,path);if(!r||isAbsolute(r)||r==='..'||r.startsWith('..'+sep))fail('Invalid package member');return path;}
async function bytes(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())fail('Regular release input required');return readFile(path);}
async function object(path){return JSON.parse((await bytes(path)).toString('utf8'));}
function run(exe,args,options={}){try{return execFileSync(exe,args,{windowsHide:true,timeout:120000,maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe'],...options});}
 catch(error){throw new Error('Native release command failed ('+(error.status??'no-exit')+'); inspect the named local validation directly.');}}

export async function inspectNativeClientCandidate({source,sourceDirectory=root}){
 if(!isAbsolute(source)||!isAbsolute(sourceDirectory))fail('Absolute native candidate and captured source required');
 const packageJson=await object(join(source,'package.json')),manifest=await object(join(source,'native-v2.json')),sourceBytes=await bytes(join(source,'source-hashes.json')),
  lockBytes=await bytes(join(source,'package-lock.json')),hashes=JSON.parse(sourceBytes),lock=JSON.parse(lockBytes);
 if(packageJson.name!=='@galaxy/native-client'||!parseComponentRelease(packageJson.version)||packageJson.private!==true||
  (!isDeepStrictEqual(packageJson.exports,originalExports)&&!isDeepStrictEqual(packageJson.exports,openCodeExports))||
  !isDeepStrictEqual(packageJson.dependencies,lock.packages?.['']?.dependencies)||
  manifest.kind!=='galaxy-native-v2-local-candidate'||manifest.containsPrivateKeys!==false||manifest.containsConfiguredAuthority!==false||
  manifest.sourceFiles!==Object.keys(hashes).length||manifest.releaseId&&manifest.releaseId!==packageJson.version)fail('Native client metadata differs');
 for(const[name,digest]of Object.entries(hashes))if(sha(await bytes(inside(sourceDirectory,name)))!==digest)fail('Native client source is stale');
 for(const[name,digest]of Object.entries(manifest.artifacts))if((!/^[a-zA-Z0-9_-]+\.js$/.test(name)&&name!=='windows-notify-icon.ps1'&&!copiedHelpers.includes(name))||sha(await bytes(inside(source,name)))!==digest)fail('Native bundle differs');
 if(isDeepStrictEqual(packageJson.exports,openCodeExports)&&(!Object.hasOwn(manifest.artifacts,'opencode.js')||!Object.hasOwn(manifest.artifacts,'setup.mjs')))fail('Native OpenCode installation entry missing');
 for(const name of copiedHelpers)if(Object.hasOwn(manifest.artifacts,name)&&manifest.artifacts[name]!==hashes['integrations/native-v2/'+name])fail('Native installation helper source differs');
 const helperSource='packages/galaxy-edge-mcp/src/native-v2/notifications/windows-notify-icon.ps1';
 if(manifest.artifacts['windows-notify-icon.ps1']!==undefined&&manifest.artifacts['windows-notify-icon.ps1']!==hashes[helperSource])fail('Native notification helper source differs');
 for(const[name,version]of Object.entries(packageJson.dependencies)){
  if(!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)||!/^\d+\.\d+\.\d+$/.test(version)||
   lock.packages?.['node_modules/'+name]?.version!==version|| (await object(join(source,'node_modules',name,'package.json'))).version!==version)fail('Native dependency lock differs');
 }
 await verifyNativeLicenseNotices({candidate:source});
 return{packageJson,manifest,sourceBytes,lockBytes};
}

async function members(source,manifest){
 const names=[...Object.keys(manifest.artifacts),'package.json','package-lock.json','source-hashes.json','native-v2.json','README.md','HOSTS.md','host-configs.mjs','host-capabilities.json','prepare-service-config.mjs'];
 async function walk(path){for(const name of await readdir(inside(source,path))){const child=path+'/'+name,info=await lstat(inside(source,child));if(info.isSymbolicLink())fail('Symlink package member forbidden');if(info.isDirectory())await walk(child);else if(info.isFile())names.push(child);else fail('Unsupported package member');}}
 for(const path of ['dist','skills','host-templates'])await walk(path);
 const license=await verifyNativeLicenseNotices({candidate:source});names.push(...Object.keys(license.files));
 const files={};for(const name of names.sort())files[name]=sha(await bytes(inside(source,name)));return files;
}
function protocolReport(report){
 if(report.version!==1||report.profile!=='galaxy-native-client/1'||report.scope!=='local-stdio-http-fixtures'||report.actualHostAcceptance!==false||
  report.humanAcceptance!==false||report.cloudModelsCalled!==false||report.status!=='passed'||!Array.isArray(report.runs)||report.runs.length!==2||
  report.runs.some((r,i)=>r.suite!==suites[i]||r.exitCode!==0||r.failures!==0||r.skipped!==0||!Number.isSafeInteger(r.passed)||r.passed<1||
   !/^[a-f0-9]{64}$/.test(r.suiteSha256)||!/^[a-f0-9]{64}$/.test(r.outputSha256)))fail('Native protocol report scope or result invalid');
 return report;
}

// No credentials. Build exact archive bytes, then run only the two relevant
// native suites. They exercise real stdio and local HTTP fixtures, not host UIs.
export async function prepareNativeClientRelease({source,destination,nodeExecutable=process.execPath,tarExecutable,sourceDirectory=root}){
 if(![source,destination,nodeExecutable,tarExecutable].every(p=>typeof p==='string'&&isAbsolute(p)))fail('Absolute preparation paths required');
 const candidate=await inspectNativeClientCandidate({source,sourceDirectory}),files=await members(source,candidate.manifest);
 await mkdir(destination);const staging=join(destination,'.pack'),packageRoot=join(staging,'package');
 await mkdir(packageRoot,{recursive:true});
 const filename='galaxy-native-client-'+candidate.packageJson.version+'.tgz',tarball=join(destination,filename);
 try{
  for(const[name,digest]of Object.entries(files)){const target=inside(packageRoot,name),content=await bytes(inside(source,name));if(sha(content)!==digest)fail('Candidate changed during capture');
   await mkdir(join(target,'..'),{recursive:true});await writeFile(target,content,{flag:'wx'});}
  // Explicit member names avoid directory links and keep package-lock.json.
  run(tarExecutable,['-czf',tarball,'-C',staging,...Object.keys(files).map(name=>'package/'+name)]);
  const names=run(tarExecutable,['-tf',tarball]).toString('utf8').trim().split(/\r?\n/);
  if(JSON.stringify(names)!==JSON.stringify(Object.keys(files).map(n=>'package/'+n)))fail('Archive member list differs');
  if(run(tarExecutable,['-tvf',tarball]).toString('utf8').trim().split(/\r?\n/).some(line=>!line.startsWith('-')))fail('Only regular archive members allowed');
  for(const[name,digest]of Object.entries(files))if(sha(run(tarExecutable,['-xOf',tarball,'package/'+name]))!==digest)fail('Archive bytes differ');
 }finally{
  const resolved=resolve(staging),prefix=resolve(destination)+sep;if(!resolved.startsWith(prefix)||relative(destination,resolved)!=='.pack')fail('Pack cleanup path differs');
  await rm(resolved,{recursive:true,force:true});
 }
 const runs=[];
 for(const suite of suites){
  const suiteSha256=sha(await bytes(join(root,suite))),output=run(nodeExecutable,['--test','--test-reporter=tap',suite],
   {cwd:root,env:{...process.env,GALAXY_NATIVE_TEST_CANDIDATE:source}});
  const text=output.toString('utf8'),count=name=>Number(new RegExp('^# '+name+' (\\d+)$','m').exec(text)?.[1]??NaN);
  if(count('fail')!==0||count('pass')<1||count('skipped')!==0||sha(await bytes(join(root,suite)))!==suiteSha256)fail('Native validation incomplete or changed');
  runs.push({suite,suiteSha256,outputSha256:sha(output),exitCode:0,passed:count('pass'),failures:count('fail'),skipped:count('skipped')});
 }
 await inspectNativeClientCandidate({source,sourceDirectory});
 for(const[name,digest]of Object.entries(files))if(sha(await bytes(inside(source,name)))!==digest)fail('Candidate changed during validation');
 const artifact=await bytes(tarball),artifactsSha256=sha(JSON.stringify(files)),sourceSha256=sha(candidate.sourceBytes);
 const report=protocolReport({version:1,profile:'galaxy-native-client/1',scope:'local-stdio-http-fixtures',status:'passed',checkedAt:new Date().toISOString(),
  packageSha256:sha(artifact),sourceSha256,artifactsSha256,runs,
  protocols:['2025-11-25','2026-07-28'],noElicitationSurface:'temporary-loopback-form-HTTP-fixture',actualHostAcceptance:false,humanAcceptance:false,
  cloudModelsCalled:false,hostCoverage:'Shared protocol only; actual product UIs, model use and background loops require separate evidence.'});
 const packageMetadata={name:candidate.packageJson.name,version:candidate.packageJson.version,filename,sha256:sha(artifact),bytes:artifact.length,exports:Object.keys(candidate.packageJson.exports),
  dependencies:candidate.packageJson.dependencies,lockSha256:sha(candidate.lockBytes),sourceHashesSha256:sourceSha256};
 const reportBytes=Buffer.from(json(report));
 await writeFile(join(destination,'protocol-report.json'),reportBytes,{flag:'wx'});
 await writeFile(join(destination,'package-files.json'),json(files),{flag:'wx'});
 await writeFile(join(destination,'package-metadata.json'),json(packageMetadata),{flag:'wx'});
 // Copy exact unsigned control inputs so signing does not need the source repo.
 await writeFile(join(destination,'source-hashes.json'),candidate.sourceBytes,{flag:'wx'});
 await writeFile(join(destination,'package-lock.json'),candidate.lockBytes,{flag:'wx'});
 return{destination,package:packageMetadata,protocolAcceptance:{profile:report.profile,scope:report.scope,reportSha256:sha(reportBytes),sourceSha256,artifactsSha256,actualHostAcceptance:false}};
}

// Caller-owned short-lived signing key injection only. No filesystem secret
// lookup, trust expansion, installation or publication.
export async function createNativeClientRelease({preparedDirectory,publisher,purpose='release-candidate',privateKey,kid,now=Math.floor(Date.now()/1000),lifetime=86400}){
 if(!isAbsolute(preparedDirectory))fail('Absolute prepared directory required');
 const packageMetadata=await object(join(preparedDirectory,'package-metadata.json')),reportBytes=await bytes(join(preparedDirectory,'protocol-report.json')),report=protocolReport(JSON.parse(reportBytes));
 if(packageMetadata.name!=='@galaxy/native-client'||!/^\d+\.\d+\.\d+$/.test(packageMetadata.version)||packageMetadata.filename!=='galaxy-native-client-'+packageMetadata.version+'.tgz')fail('Native release package mismatch');
 const artifact=await bytes(inside(preparedDirectory,packageMetadata.filename)),files=await object(join(preparedDirectory,'package-files.json')),
  sources=await bytes(join(preparedDirectory,'source-hashes.json')),lockBytes=await bytes(join(preparedDirectory,'package-lock.json')),lock=JSON.parse(lockBytes);
 if(sha(artifact)!==packageMetadata.sha256||artifact.length!==packageMetadata.bytes||report.packageSha256!==packageMetadata.sha256||
  sha(sources)!==packageMetadata.sourceHashesSha256||report.sourceSha256!==sha(sources)||report.artifactsSha256!==sha(JSON.stringify(files))||
  packageMetadata.lockSha256!==sha(lockBytes)||!isDeepStrictEqual(lock.packages?.['']?.dependencies,packageMetadata.dependencies))fail('Prepared native release bytes differ');
 const manifest={version:1,kind:'galaxy-native-client-release',publisher,purpose,issuedAt:now,expiresAt:now+lifetime,package:packageMetadata,
  protocolAcceptance:{profile:report.profile,scope:report.scope,reportSha256:sha(reportBytes),sourceSha256:report.sourceSha256,artifactsSha256:report.artifactsSha256,actualHostAcceptance:false}};
 return{manifest,signed:await signRelease(manifest,{privateKey,kid}),reportBytes,artifact};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await prepareNativeClientRelease({source:process.argv[2],destination:process.argv[3],tarExecutable:process.argv[4],sourceDirectory:process.argv[5]??root})));
