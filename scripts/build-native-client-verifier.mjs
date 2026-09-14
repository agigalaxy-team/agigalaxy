import {build,version as esbuildVersion} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('..',import.meta.url)),destination=process.argv[2];
if(!destination||!isAbsolute(destination))throw new Error('Absolute existing publication directory required');
const result=await build({absWorkingDir:root,entryPoints:['scripts/verify-native-client-download.mjs'],bundle:true,
 platform:'node',format:'esm',target:'node22',write:false,metafile:true,legalComments:'inline'});
const directories=new Set();
for(const key of Object.keys(result.metafile.inputs)){
 const path=key.replaceAll('\\','/'),marker=path.lastIndexOf('node_modules/');if(marker<0)continue;
 const prefix=path.slice(0,marker)+'node_modules/',parts=path.slice(marker+13).split('/');
 const name=parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0];directories.add(resolve(root,prefix+name));
}
const licenses=[];
for(const directory of directories){
 const metadata=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));let found=false;
 for(const filename of ['LICENSE','LICENSE.md','LICENSE.txt','LICENCE','NOTICE','NOTICE.md','NOTICE.txt']){
  let body;try{body=await readFile(join(directory,filename),'utf8');}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(body.includes('*/'))throw new Error('License requires a separate attachment profile');
  licenses.push({name:metadata.name,version:metadata.version,filename,body});found=true;
 }
 if(!found)throw new Error('Bundled dependency lacks license text: '+metadata.name);
}
const notice='/*\nBundled dependency license texts (original installed versions):\n'+licenses.map(l=>'\n'+l.name+' '+l.version+' — '+l.filename+'\n'+l.body).join('\n')+'\n*/\n';
const bytes=Buffer.concat([Buffer.from(notice),result.outputFiles[0].contents]),filename='verify-native-client-download.mjs';
await writeFile(join(destination,filename),bytes,{flag:'wx'});
const metadata={filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),builder:'esbuild '+esbuildVersion,
 bundledLicenseTexts:licenses.map(({body,...v})=>({...v,sha256:createHash('sha256').update(body).digest('hex')})),containsPrivateKeys:false};
await writeFile(join(destination,'verifier-build.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(metadata));
