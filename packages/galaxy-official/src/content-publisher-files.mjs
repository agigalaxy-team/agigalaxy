import {cp,lstat,mkdir,readFile,readdir,realpath,rename,symlink,writeFile,unlink,rmdir} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,dirname,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {contentSnapshotSchema} from './content-publications.mjs';

const execute=promisify(execFile),marker='cms-publication.json';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const inside=(root,path)=>{const part=relative(root,path);return part!==''&&!part.startsWith('..'+sep)&&part!=='..'&&!isAbsolute(part);};
async function directory(path){if(!isAbsolute(path))throw Error('Absolute publisher path required');const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Publisher directory required');return realpath(path);}
async function regular(path,max=21000000){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw Error('Publisher regular file required');return info;}
export async function loadContentPublisherConfiguration(path){
  if(!isAbsolute(path))throw Error('Absolute publisher configuration required');
  const info=await regular(path,16384);
  if(process.platform!=='win32'&&(info.mode&0o022))throw Error('Publisher configuration must not be writable by other users');
  const value=JSON.parse(await readFile(path,'utf8'));
  const keys=['version','endpoint','publicOrigin','adminOrigin','baseDirectory','releaseDirectory','currentLink','mediaDirectory','renderer','python'];
  if(value.version!==1||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error('Invalid publisher configuration');
  for(const key of ['endpoint','publicOrigin','adminOrigin'])if(new URL(value[key]).origin!==value[key]||!value[key].startsWith('https://'))throw Error('Exact HTTPS publisher origin required');
  for(const key of ['baseDirectory','releaseDirectory','currentLink','mediaDirectory','renderer','python'])if(!isAbsolute(value[key]))throw Error('Absolute publisher paths required');
  return value;
}

// Publication runs as a dedicated system account. It reads public CMS media and
// an immutable software build, and can replace only the configured website link.
export async function createFilesystemContentPublisher(config){
  const base=await directory(config.baseDirectory),releases=await directory(config.releaseDirectory),media=await directory(config.mediaDirectory);
  if(base===releases||inside(base,releases)||inside(base,resolve(config.currentLink)))throw Error('Separate publisher source and output required');
  await regular(config.renderer,2000000);
  const parent=await realpath(dirname(config.currentLink));
  const current=async()=>{
    try{
      const info=await lstat(config.currentLink);if(!info.isSymbolicLink())throw Error('Website pointer must be a symbolic link');
      const path=await realpath(config.currentLink);if(!inside(releases,path))throw Error('Website pointer escaped its release directory');
      await regular(join(path,marker),4096);return JSON.parse(await readFile(join(path,marker),'utf8'));
    }catch(error){if(error.code==='ENOENT')return null;throw error;}
  };
  async function prepare({publicationId,snapshot,signal}){
    if(!uuid.test(publicationId))throw Error('Invalid publication reference');
    snapshot=contentSnapshotSchema.parse(snapshot);
    const temporary=join(releases,'.cms-'+publicationId+'-'+randomUUID());
    await mkdir(temporary,{mode:0o750});
    const copyOptions={recursive:true,force:false,errorOnExist:true,filter:async source=>{
      signal?.throwIfAborted();const info=await lstat(source);if(info.isSymbolicLink())throw Error('Website build must not contain symbolic links');return true;
    }};
    for(const name of await readdir(base))await cp(join(base,name),join(temporary,name),copyOptions);
    const privateInput=join(releases,'.cms-input-'+randomUUID());await mkdir(privateInput,{mode:0o700});
    const selectedMedia=join(privateInput,'media');await mkdir(selectedMedia,{mode:0o700});
    const selectedIds=new Set(snapshot.pages.flatMap(page=>page.blocks.filter(block=>block.blockType==='image').map(block=>block.mediaId)));
    const filenames=new Set(),input=join(privateInput,'snapshot.json');
    try{
    for(const item of snapshot.media.filter(item=>selectedIds.has(item.id))){
      signal?.throwIfAborted();const url=new URL(item.url,config.adminOrigin);
      if(url.origin!==config.adminOrigin||url.search||url.hash||!url.pathname.startsWith('/api/media/file/'))throw Error('CMS media origin changed');
      let filename;try{filename=decodeURIComponent(url.pathname.slice('/api/media/file/'.length));}catch{throw Error('Invalid CMS media path');}
      if(filename!==item.filename||/[\\/]/.test(filename))throw Error('CMS media reference changed');
      const source=join(media,filename),info=await regular(source);
      if(info.size!==item.filesize||!inside(media,await realpath(source)))throw Error('CMS media no longer matches the selected file');
      if(!filenames.has(filename))await cp(source,join(selectedMedia,filename),{errorOnExist:true,force:false});
      filenames.add(filename);
    }
    await writeFile(input,JSON.stringify(snapshot),{mode:0o600,flag:'wx'});
    await execute(config.python,[config.renderer,'--site',temporary,'--snapshot',input,'--media-dir',selectedMedia],{
      timeout:60000,maxBuffer:65536,signal,env:{PATH:process.env.PATH??'',LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'},windowsHide:true});
    }finally{
      for(const name of filenames)await unlink(join(selectedMedia,name)).catch(()=>{});
      await unlink(input).catch(()=>{});await rmdir(selectedMedia).catch(()=>{});await rmdir(privateInput).catch(()=>{});
    }
    const software=JSON.parse(await readFile(join(base,'release.json'),'utf8'));
    const result={version:1,publicationId,siteVersion:software.version,createdAt:new Date().toISOString()};
    await writeFile(join(temporary,marker),JSON.stringify(result)+'\n',{mode:0o640});
    // Candidate data is never in the active web root until activate succeeds.
    return {...result,directory:temporary};
  }
  async function activate(artifact){
    const candidate=await directory(artifact.directory);
    if(!inside(releases,candidate)||!uuid.test(artifact.publicationId))throw Error('Publication escaped release directory');
    const recorded=JSON.parse(await readFile(join(candidate,marker),'utf8'));
    if(recorded.publicationId!==artifact.publicationId)throw Error('Publication reference changed');
    const info=await lstat(config.currentLink);if(!info.isSymbolicLink())throw Error('Website pointer must be a symbolic link');
    const link=join(parent,'.website-next-'+randomUUID());
    await symlink(relative(parent,candidate),link,'dir');
    try{await rename(link,config.currentLink);}catch(error){await unlink(link).catch(()=>{});throw error;}
  }
  return {current,prepare,activate};
}
