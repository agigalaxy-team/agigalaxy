import type {CollectionConfig,PayloadRequest} from 'payload';
import {canEdit,canRead} from '../lib/access';
import {safePagePath} from '../lib/content-model.mjs';
import {siteBlocks} from '../blocks/siteBlocks';
import {mediaPublication} from './Media';

function imageIds(page:unknown):string[]{
  if(!page||typeof page!=='object'||!('blocks'in page)||!Array.isArray(page.blocks))return [];
  return page.blocks.flatMap((block:unknown)=>{
    if(!block||typeof block!=='object'||!('blockType'in block)||block.blockType!=='image'||!('media'in block))return [];
    const media=block.media,id=typeof media==='object'&&media!==null&&'id'in media?media.id:media;
    return typeof id==='string'||typeof id==='number'?[String(id)]:[];
  });
}
async function updateMediaVisibility(req:PayloadRequest,affected:string[]){
  if(!affected.length)return;
  const used=new Set<string>();let page=1,more=true;
  while(more){
    const result=await req.payload.find({collection:'site-pages',where:{_status:{equals:'published'}},draft:false,limit:100,page,depth:0,overrideAccess:false,user:req.user,req});
    for(const document of result.docs)for(const id of imageIds(document))used.add(id);
    more=result.hasNextPage;page++;
  }
  for(const id of new Set(affected))await req.payload.update({collection:'media',id,data:{published:used.has(id)},overrideAccess:false,user:req.user,req,context:{mediaPublication}});
}
export const SitePages:CollectionConfig={
  slug:'site-pages',labels:{singular:'官网页面',plural:'官网页面'},
  admin:{useAsTitle:'title',defaultColumns:['title','path','_status','updatedAt'],preview:document=>'/preview/pages/'+encodeURIComponent(String(document.id))},
  access:{read:canRead,create:canEdit,update:canEdit,delete:canEdit,readVersions:canRead},
  // Keep the native explicit draft save. Autosaving a new document navigates
  // create -> edit and can replace fields the editor is still entering.
  versions:{drafts:true,maxPerDoc:50},
  fields:[
    {name:'title',label:'页面名称',type:'text',required:true,maxLength:200},
    {name:'path',label:'网址路径',type:'text',required:true,unique:true,index:true,validate:(value:unknown)=>safePagePath(value)||'使用小写站内路径，例如 /about/；不能占用账户或服务地址。'},
    {name:'description',label:'简介',type:'textarea',maxLength:600},
    {name:'blocks',label:'页面内容',type:'blocks',blocks:siteBlocks,maxRows:80},
  ],
  hooks:{
    afterChange:[async({doc,previousDoc,req})=>{if(doc._status==='published'||previousDoc?._status==='published')await updateMediaVisibility(req,[...imageIds(doc),...imageIds(previousDoc??{})]);return doc;}],
    afterDelete:[async({doc,req})=>{await updateMediaVisibility(req,imageIds(doc));return doc;}],
  },
};
