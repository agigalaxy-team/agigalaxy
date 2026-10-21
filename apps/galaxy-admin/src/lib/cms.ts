import {getPayload} from 'payload';
import config from '@payload-config';
import {isOperator} from './access';
import {publishedSnapshot} from './content-model.mjs';
import {adminEnvironment} from './environment.mjs';

export async function authenticatedCMS(requestHeaders:Headers){
  const payload=await getPayload({config}),authentication=await payload.auth({headers:requestHeaders});
  if(!isOperator(authentication.user))return null;
  return {payload,user:authentication.user};
}
export async function exportPublishedSite(context:NonNullable<Awaited<ReturnType<typeof authenticatedCMS>>>){
  const {payload,user}=context;
  const settings=await payload.findGlobal({slug:'site-settings',draft:false,depth:0,overrideAccess:false,user});
  const pages:{id:string|number;blocks?:unknown}[]=[];let page=1,hasNextPage=true;
  while(hasNextPage){
    const result=await payload.find({collection:'site-pages',where:{_status:{equals:'published'}},draft:false,depth:0,limit:100,page,sort:'path',overrideAccess:false,user});
    pages.push(...result.docs);hasNextPage=result.hasNextPage;page++;
  }
  const ids=new Set<string>();
  for(const document of pages){
    if(!Array.isArray(document.blocks))continue;
    for(const block of document.blocks as unknown[]){
      if(!block||typeof block!=='object'||!('blockType'in block)||block.blockType!=='image'||!('media'in block))continue;
      const media=block.media,id=typeof media==='object'&&media!==null&&'id'in media?media.id:media;
      if(typeof id==='string'||typeof id==='number')ids.add(String(id));
    }
  }
  const {publicOrigin}=adminEnvironment();
  const media=await Promise.all([...ids].map(async id=>{
    const document=await payload.findByID({collection:'media',id,depth:0,overrideAccess:false,user});
    if(document.published!==true||typeof document.url!=='string')throw Error('published_media_unavailable');
    return {...document,url:new URL(document.url,publicOrigin).href};
  }));
  return publishedSnapshot({settings,pages,media});
}
