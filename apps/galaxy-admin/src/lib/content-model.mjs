export const blockTypes=['hero','prose','linkList','image','notice','releaseLinks'];
export const reservedPrefixes=['/admin','/api','/app','/v1','/v2','/preview','/assets','/archives','/media','/releases','/downloads','/docs','/404'];
const managedExisting=new Set(['/how-it-works/','/network/','/privacy/','/start/','/docs/','/downloads/','/downloads/verification/','/status/']);
export function safeHref(value){return typeof value==='string'&&value.length<=2048&&!/[\u0000-\u0020\u007f\\]/.test(value)&&(/^(?!\/\/)\/(?!\/)/.test(value)||/^https:\/\//.test(value)&&(()=>{try{const url=new URL(value);return !url.username&&!url.password;}catch{return false;}})());}
export function safePagePath(value){return typeof value==='string'&&/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/.test(value)&&(managedExisting.has(value)||!reservedPrefixes.some(prefix=>value===prefix||value.startsWith(prefix+'/')));}
export function projectBlocks(blocks,media){
  const assets=media.map(item=>({id:String(item.id),url:item.url,filename:item.filename,alt:item.alt,width:item.width??null,height:item.height??null,mimeType:item.mimeType,filesize:item.filesize,credit:item.credit??''}));
  const available=new Map(assets.map(item=>[item.id,item]));
  const reference=value=>typeof value==='object'&&value!==null?String(value.id):String(value);
  const link=({label,href,description})=>{if(!safeHref(href))throw Error('unsafe_site_link');return {label,href,...(description?{description}:{})};};
  const safeBlock=block=>{
    if(!blockTypes.includes(block.blockType))throw Error('unsupported_site_block');
    const base={blockType:block.blockType};
    if(block.blockType==='hero')return {...base,heading:block.heading,text:block.text??'',links:(block.links??[]).map(link)};
    if(block.blockType==='prose')return {...base,heading:block.heading??'',body:block.body};
    if(block.blockType==='linkList')return {...base,heading:block.heading??'',links:(block.links??[]).map(link)};
    if(block.blockType==='notice')return {...base,tone:block.tone,title:block.title,text:block.text};
    if(block.blockType==='releaseLinks'){if(block.channel!=='stable')throw Error('unsupported_release_channel');return {...base,heading:block.heading??'',channel:'stable',label:block.label};}
    const asset=available.get(reference(block.media));if(!asset)throw Error('published_media_unavailable');
    return {...base,mediaId:asset.id,caption:block.caption??''};
  };
  return {blocks:(blocks??[]).map(safeBlock),media:assets};
}
export function publishedSnapshot({settings,pages,media}){
  if(settings._status!=='published')throw Error('unpublished_site_settings');
  const assets=projectBlocks([],media).media;
  const footerLinks=(settings.footerLinks??[]).map(({label,href})=>{if(!safeHref(href))throw Error('unsafe_site_link');return {label,href};});
  return {version:1,settings:{siteTitle:settings.siteTitle,description:settings.description??'',footerLinks},pages:pages.map(page=>{
    if(!safePagePath(page.path)||page._status!=='published')throw Error('unpublished_site_page');
    return {id:String(page.id),path:page.path,title:page.title,description:page.description??'',blocks:projectBlocks(page.blocks,media).blocks,updatedAt:page.updatedAt};
  }),media:assets};
}
