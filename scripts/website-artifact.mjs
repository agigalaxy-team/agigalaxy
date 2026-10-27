import {cp} from 'node:fs/promises';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';

function files(root,prefix=''){
 return readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(entry=>{
  if(entry.isSymbolicLink())throw Error('Website static assets must not contain links');
  const name=prefix?prefix+'/'+entry.name:entry.name;
  return entry.isDirectory()?files(root,name):entry.isFile()?[name]:[];
 });
}
/** Carry only the previous build's own public assets, never its dependencies or content. */
export async function packWebsiteRuntime({root,artifact,content,previousRuntime}){
 const built=path.join(root,'apps/galaxy-site/.next');
 if(existsSync(artifact)&&readdirSync(artifact).length)throw Error('Runtime artifact directory must be empty');
 await cp(path.join(built,'standalone'),artifact,{recursive:true});
 const app=path.join(artifact,'apps/galaxy-site'),target=path.join(app,'.next/static');
 mkdirSync(path.dirname(target),{recursive:true});await cp(path.join(built,'static'),target,{recursive:true});
 const current=files(target);
 const required=path.join(built,'required-server-files.json');
 const deploymentId=existsSync(required)?JSON.parse(readFileSync(required,'utf8')).config?.deploymentId??null:null;
 if(previousRuntime){
  const source=path.join(previousRuntime,'apps/galaxy-site/.next/static');
  const previous=JSON.parse(readFileSync(path.join(previousRuntime,'public-build-assets.json'),'utf8'));
  if(previous.version!==1||!Array.isArray(previous.files))throw Error('A compatible previous runtime asset manifest is required');
  for(const file of previous.files){
   if(typeof file!=='string'||!file||file.split('/').some(part=>!part||part==='.'||part==='..'||part.includes('\\')))throw Error('Invalid previous public asset path');
   const from=path.join(source,file),to=path.join(target,file);
   if(!lstatSync(from).isFile()||lstatSync(from).isSymbolicLink())throw Error('Previous public asset must be a regular file');
   if(!existsSync(to)){mkdirSync(path.dirname(to),{recursive:true});await cp(from,to,{errorOnExist:true});}
  }
 }
 if(existsSync(path.join(root,'apps/galaxy-site/public')))await cp(path.join(root,'apps/galaxy-site/public'),path.join(app,'public'),{recursive:true});
 await cp(content,path.join(artifact,'content'),{recursive:true});
 writeFileSync(path.join(artifact,'public-build-assets.json'),JSON.stringify({version:1,deploymentId,files:current})+'\n');
 writeFileSync(path.join(artifact,'start.mjs'),`import {fileURLToPath} from 'node:url';\nprocess.env.GALAXY_SITE_BASELINE_ROOT??=fileURLToPath(new URL('./content/',import.meta.url));\nprocess.env.GALAXY_SITE_PUBLIC_ROOT??=process.env.GALAXY_SITE_BASELINE_ROOT;\nawait import('./apps/galaxy-site/server.js');\n`);
}
