import {readFile,writeFile,lstat,readdir,mkdir} from 'node:fs/promises';
import {resolve,relative,join,dirname,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const root=fileURLToPath(new URL('../',import.meta.url)),legal=join(root,'integrations/native-v2/legal');
const sha=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,null,2)+'\n';
const fail=message=>{throw new Error(message);};
function inside(base,name){const path=resolve(base,name),rel=relative(base,path);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))fail('License path outside candidate');return path;}
async function bytes(path){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())fail('License input must be a regular file');return readFile(path);}
async function object(path){return JSON.parse((await bytes(path)).toString('utf8'));}
const legalName=name=>/^(licen[sc]e|copying|notice|copyright|authors)(?:[._-].*)?$/i.test(name);

// This scans the exact candidate installation. It performs no npm install,
// registry request, global lookup, source-license substitution or publication.
async function collect(candidate){
 if(!isAbsolute(candidate))fail('Absolute native candidate required');
 const pkg=await object(join(candidate,'package.json')),lockBytes=await bytes(join(candidate,'package-lock.json')),lock=JSON.parse(lockBytes),
  manifest=await object(join(candidate,'native-v2.json')),sourceBytes=await bytes(join(candidate,'source-hashes.json'));
 if(pkg.name!=='@galaxy/native-go-candidate'||pkg.license!=='Apache-2.0'||manifest.kind!=='galaxy-native-go-local-candidate'
  ||!isDeepStrictEqual(pkg.dependencies,lock.packages?.['']?.dependencies))fail('Native licensing package or dependency lock differs');
 const files={},components=[];
 for(const name of ['LICENSE','NOTICE']){const original=await bytes(join(legal,name));if(!original.equals(await bytes(join(candidate,name))))fail('First-party '+name+' differs');}
 const expected=Object.entries(lock.packages).filter(([name])=>name).sort(([a],[b])=>a.localeCompare(b,'en'));
 for(const[path,entry]of expected){
  if(entry.dev||entry.link||!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path))fail('Unexpected native lock member '+path);
  const folder=inside(candidate,path);let stat;try{stat=await lstat(folder);}catch(error){if(error.code==='ENOENT'&&entry.optional)continue;throw error;}if(!stat.isDirectory()||stat.isSymbolicLink())fail('Installed dependency directory required: '+path);
  const packageBytes=await bytes(join(folder,'package.json')),dependency=JSON.parse(packageBytes),expectedName=path.slice(path.lastIndexOf('node_modules/')+13);
  if(dependency.name!==expectedName||dependency.version!==entry.version)fail('Installed license dependency differs: '+path);
  const texts=[];
  async function scan(directory,prefix=''){
   for(const item of (await readdir(directory)).sort()){
    const source=join(directory,item),info=await lstat(source),name=prefix+item;
    if(info.isSymbolicLink())continue;
    if(info.isFile()&&legalName(item))texts.push({source,name});
    else if(info.isDirectory()&&/^(licen[sc]es?|legal|notices?)$/i.test(item))await scan(source,name+'/');
   }
  }
  await scan(folder);
  if(!texts.some(x=>/^(licen[sc]e|copying)/i.test(x.name)))fail('Upstream license text missing: '+path);
  const identifier=dependency.name.replaceAll('/','__')+'@'+dependency.version+'-'+sha(path).slice(0,8),notices=[];let transition=false;
  for(const text of texts){const content=await bytes(text.source),output='third-party-licenses/'+identifier+'/'+text.name;
   if(/licensing transition/i.test(content.toString('utf8')))transition=true;
   files[output]=content;notices.push({sourcePath:path+'/'+text.name,path:output,sha256:sha(content),bytes:content.length});}
  components.push({name:dependency.name,version:dependency.version,installationPath:path,relationship:'external-runtime-dependency',
   upstreamPackageModified:false,packageMetadataSha256:sha(packageBytes),lockIntegrity:entry.integrity??null,
   declaredPackageLicense:dependency.license??null,declaredLockLicense:entry.license??null,
   licenseInterpretation:transition?'upstream-license-transition-and-retained-original-terms':'see-unchanged-upstream-text',notices});
 }
 // Keep tool attribution separately: no esbuild executable or dependency is
 // added to the installed native runtime by this notice.
 const builder=await object(join(root,'node_modules/esbuild/package.json')),builderText=await bytes(join(root,'node_modules/esbuild/LICENSE.md'));
 if(manifest.builder!=='esbuild '+builder.version)fail('Native builder notice version differs');
 const builderPath='third-party-licenses/build-tool-esbuild-'+builder.version+'/LICENSE.md';files[builderPath]=builderText;
 const inventory={version:1,profile:'galaxy-native-license-inventory/v1',authority:'CUR-33/ROOT-Q-RELEASE-POLICY; execution CUR-35',
  scope:'selected-first-party-native-distribution-only; not-entire-repository-or-user-data',firstPartyLicense:'Apache-2.0',
  packageName:pkg.name,packageVersion:pkg.version,lockSha256:sha(lockBytes),sourceHashesSha256:sha(sourceBytes),
  thirdPartyCodeBundled:true,bundledCodeScope:'compact app SDK; see dist/EXT_APPS_LICENSE.txt',packageMetadataIsNotLicenseText:true,components,
  buildTool:{name:builder.name,version:builder.version,relationship:'build-tool-attribution; binary-not-distributed',
   notice:{path:builderPath,sha256:sha(builderText),bytes:builderText.length}}};
 const lines=['# Third-party notices for the selected Galaxy native distribution','',
  'Galaxy-authored files in this selected distribution use Apache-2.0. Third-party components retain their original terms; this table does not relicense them.',
  'Host adapter runtime dependencies are installed from package-lock.json. Their package files are unmodified. The compact app includes the SDK code and its original text at dist/EXT_APPS_LICENSE.txt.',
  'The metadata label is shown for provenance only. Read the complete copied upstream license and NOTICE texts, including any mixed-license or documentation-only conditions.','',
  '| Component | Installed version | Package metadata | Original texts |','| --- | --- | --- | --- |'];
 for(const c of components)lines.push(`| ${c.name} | ${c.version} | ${JSON.stringify(c.declaredPackageLicense).replaceAll('|','\\|')} | ${c.notices.map(n=>`[${n.sourcePath.slice(c.installationPath.length+1)}](${n.path})`).join(', ')} |`);
 lines.push('',`Build-tool attribution only: esbuild ${builder.version}, [original license](${builderPath}). Its executable is not included.`,
  '', 'Applicable upstream license, NOTICE and documentation terms remain in their full original texts. No global conversion to Apache-2.0 is asserted.',
  '', 'Exact source paths, component versions, file byte counts and SHA256 digests are recorded in license-inventory.json. This is a distribution inventory, not host compatibility, operational availability, or data-sharing permission.','');
 files['THIRD_PARTY_NOTICES.md']=Buffer.from(lines.join('\n'));files['license-inventory.json']=Buffer.from(json(inventory));
 return {inventory,files};
}

export async function generateNativeLicenseNotices({candidate}){
 const generated=await collect(candidate);
 // Never overwrite a previous generated inventory or a frozen package.
 await mkdir(join(candidate,'third-party-licenses'),{recursive:true});
 for(const[name,content]of Object.entries(generated.files)){const path=inside(candidate,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,content,{flag:'wx'});}
 return {candidate,components:generated.inventory.components.length,generatedFiles:Object.keys(generated.files).length,
  lockSha256:generated.inventory.lockSha256,networkCalls:0,thirdPartyCodeBundled:true};
}
export async function verifyNativeLicenseNotices({candidate}){
 const expected=await collect(candidate);
 for(const[name,content]of Object.entries(expected.files))if(!content.equals(await bytes(inside(candidate,name))))fail('Native license inventory or original text changed: '+name);
 const files={LICENSE:sha(await bytes(join(candidate,'LICENSE'))),NOTICE:sha(await bytes(join(candidate,'NOTICE')))};
 for(const[name,content]of Object.entries(expected.files))files[name]=sha(content);
 return {files,components:expected.inventory.components.length,lockSha256:expected.inventory.lockSha256,readOnly:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const command=process.argv[2];if(!['generate','verify'].includes(command))fail('Use generate or verify and an absolute new candidate directory');
 console.log(JSON.stringify(await(command==='generate'?generateNativeLicenseNotices:verifyNativeLicenseNotices)({candidate:process.argv[3]})));
}
