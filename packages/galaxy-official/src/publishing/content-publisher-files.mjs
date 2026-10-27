import {cp,lstat,mkdir,readFile,realpath,rename,symlink,writeFile,unlink} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,dirname,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {contentSnapshotSchema} from './content-snapshot.mjs';

const marker='cms-publication.json';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const inside=(root,path)=>{const part=relative(root,path);return part!==''&&!part.startsWith('..'+sep)&&part!=='..'&&!isAbsolute(part);};
async function directory(path){if(!isAbsolute(path))throw Error('Absolute publisher path required');const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Publisher directory required');return realpath(path);}
async function regular(path,max=21000000){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw Error('Publisher regular file required');return info;}
export async function loadContentPublisherConfiguration(path){
  if(!isAbsolute(path))throw Error('Absolute publisher configuration required');
  const info=await regular(path,16384);
  if(process.platform!=='win32'&&(info.mode&0o022))throw Error('Publisher configuration must not be writable by other users');
  const value=JSON.parse(await readFile(path,'utf8'));
  const keys=['version','endpoint','publicOrigin','adminOrigin','baseDirectory','releaseDirectory','currentLink','mediaDirectory'];
  if(value.version!==1||keys.some(key=>!(key in value))||Object.keys(value).some(key=>!keys.includes(key)&&!['renderer','python'].includes(key)))throw Error('Invalid publisher configuration');
  for(const key of ['endpoint','publicOrigin','adminOrigin'])if(new URL(value[key]).origin!==value[key]||!value[key].startsWith('https://'))throw Error('Exact HTTPS publisher origin required');
  for(const key of ['baseDirectory','releaseDirectory','currentLink','mediaDirectory'])if(!isAbsolute(value[key]))throw Error('Absolute publisher paths required');
  return value;
}

// Publication runs as a dedicated system account. It reads public CMS media and
// an immutable software build, and can replace only the configured website link.
export async function createFilesystemContentPublisher(config){
  const base=await directory(config.baseDirectory),releases=await directory(config.releaseDirectory),media=await directory(config.mediaDirectory);
  if(base===releases||inside(base,releases)||inside(base,resolve(config.currentLink)))throw Error('Separate publisher source and output required');

  const parent=await realpath(dirname(config.currentLink));
  const current=async()=>{
    let info;try{info=await lstat(config.currentLink);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(!info.isSymbolicLink())throw Error('Website pointer must be a symbolic link');
    const path=await realpath(config.currentLink);if(!inside(releases,path))throw Error('Website pointer escaped its release directory');
    await regular(join(path,marker),4096);const value=JSON.parse(await readFile(join(path,marker),'utf8'));
    if(value.version===1&&value.mode==='baseline'&&value.publicationId===null)return null;
    if(value.version!==1||!uuid.test(value.publicationId)||value.mode!==undefined&&value.mode!=='published')throw Error('Invalid active publication marker');
    return value;
  };
  async function prepare({publicationId,snapshot,signal}){
    signal?.throwIfAborted();
    if(!uuid.test(publicationId))throw Error('Invalid publication reference');
    snapshot=contentSnapshotSchema.parse(snapshot);
    const temporary=join(releases,'.cms-'+publicationId+'-'+randomUUID());
    await mkdir(temporary,{mode:0o750});
    const selectedMedia=join(temporary,'media');await mkdir(selectedMedia,{mode:0o750});
    const selectedIds=new Set(snapshot.pages.flatMap(page=>page.blocks.filter(block=>block.blockType==='image').map(block=>block.mediaId)));
    const filenames=new Set();
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
    // Only validated public data and selected media enter the immutable release.
    const publicSnapshot={...snapshot,media:snapshot.media.filter(item=>selectedIds.has(item.id)).map(item=>({...item,url:'/media/cms/'+encodeURIComponent(item.id)+'/'+encodeURIComponent(item.filename)}))};
    await writeFile(join(temporary,'cms-snapshot.json'),JSON.stringify(publicSnapshot)+'\n',{mode:0o640,flag:'wx'});
    await regular(join(base,'release.json'),65536);
    const software=JSON.parse(await readFile(join(base,'release.json'),'utf8'));
    if(typeof software.version!=='string'||!software.version)throw Error('Software version required');
    signal?.throwIfAborted();
    const result={version:1,mode:'published',publicationId,siteVersion:software.version,createdAt:new Date().toISOString()};
    await writeFile(join(temporary,marker),JSON.stringify(result)+'\n',{mode:0o640});
    // Candidate data is never in the active web root until activate succeeds.
    return {...result,directory:temporary};
  }
  async function activate(artifact){
    const candidate=await directory(artifact.directory);
    if(!inside(releases,candidate)||!uuid.test(artifact.publicationId))throw Error('Publication escaped release directory');
    const recorded=JSON.parse(await readFile(join(candidate,marker),'utf8'));
    if(recorded.publicationId!==artifact.publicationId)throw Error('Publication reference changed');
    await regular(join(candidate,'cms-snapshot.json'),1048576);
    contentSnapshotSchema.parse(JSON.parse(await readFile(join(candidate,'cms-snapshot.json'),'utf8')));
    try{const info=await lstat(config.currentLink);if(!info.isSymbolicLink())throw Error('Website pointer must be a symbolic link');}catch(error){if(error.code!=='ENOENT')throw error;}
    const link=join(parent,'.website-next-'+randomUUID());
    await symlink(relative(parent,candidate),link,'dir');
    try{await rename(link,config.currentLink);}catch(error){await unlink(link).catch(()=>{});throw error;}
  }
  return {current,prepare,activate};
}
