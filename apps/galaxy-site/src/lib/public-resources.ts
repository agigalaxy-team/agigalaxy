import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readSiteContent,safePublicFile} from './site-content';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const deny=()=>new Response('Not found',{status:404,headers});
const publicTypes=new Set(['text/html','application/xml','application/gzip','text/css','text/javascript','application/javascript','application/json','text/plain','text/markdown','image/svg+xml','image/png','image/jpeg','image/gif','image/webp','image/avif','image/x-icon','application/pdf','application/zip','application/octet-stream','application/vnd.microsoft.portable-executable','application/x-apple-diskimage']);
export async function servePublicResource(segments:string[]){
 try{
  if(segments.some(part=>!part||part==='.'||part==='..'||/[\\/:]/.test(part)||Array.from(part).some(char=>char.charCodeAt(0)<32)))return deny();
  if(segments[0]==='media'&&segments[1]==='cms'){
   if(segments.length!==4)return deny();
   const content=await readSiteContent();if(content.mode!=='published')return deny();
   const item=content.snapshot.media.find(item=>item.id===segments[2]&&item.filename===segments[3]);if(!item)return deny();
   const file=await safePublicFile(process.env.GALAXY_SITE_CONTENT_ROOT!,['media',item.filename]);
   if(file.size!==item.filesize)return deny();
   return new Response(await readFile(file.path),{headers:{...headers,'Content-Type':item.mimeType,'Content-Length':String(file.size)}});
  }
  const root=resolve(/* turbopackIgnore: true */ process.env.GALAXY_SITE_PUBLIC_ROOT??process.env.GALAXY_SITE_BASELINE_ROOT??resolve(process.cwd(),'dist'));
  const manifest=JSON.parse(await readFile((await safePublicFile(root,['public-assets.json'],1048576)).path,'utf8'));
  if(manifest.version!==1||!Array.isArray(manifest.files))return deny();
  const path=segments.join('/');
  // Even a malformed manifest may never expose the publication or compiler inputs.
  if(segments.some(part=>part.startsWith('.')||/^(?:cms-(?:snapshot|publication)|baseline-content|home-content|public-assets)\.json$/i.test(part)))return deny();
  const selected=manifest.files.find((item:{path:string;contentType:string})=>item.path===path);
  if(!selected||!publicTypes.has(selected.contentType))return deny();
  const file=await safePublicFile(root,segments,256*1024*1024);
  return new Response(await readFile(file.path),{headers:{...headers,'Content-Type':selected.contentType,'Content-Length':String(file.size)}});
 }catch{return deny();}
}
