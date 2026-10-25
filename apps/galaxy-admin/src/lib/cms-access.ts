import {APIError} from 'payload';
import type {PayloadRequest} from 'payload';
import {hasOperatorPermission,isOperator} from './access';

export function enforceCmsPublication({data,originalDoc,req}:{data:Record<string,unknown>;originalDoc?:Record<string,unknown>;req:PayloadRequest}){
 const nextStatus=data._status??originalDoc?._status??'draft';
 // Payload normalizes native Save Draft to _status=draft before this hook.
 // A draft write keeps the live publication; an explicit unpublish does not.
 const draftWrite=req.query?.draft===true||req.query?.draft==='true';
 const publication=nextStatus==='published'||originalDoc?._status==='published'&&nextStatus==='draft'&&!draftWrite;
 if(publication&&(!isOperator(req.user)||!hasOperatorPermission(req.user,'cms.publish')))throw new APIError('当前管理身份没有发布或撤下站点内容的权限。',403);
 if(data._status===undefined)data={...data,_status:nextStatus};
 return data;
}
export async function enforcePublishedPageDeletion({req,id}:{req:PayloadRequest;id:string|number}){
 const document=await req.payload.findByID({collection:'site-pages',id,depth:0,overrideAccess:false,user:req.user,req});
 if(document._status==='published'&&!hasOperatorPermission(req.user,'cms.publish'))throw new APIError('当前管理身份没有撤下已发布站点内容的权限。',403);
}
