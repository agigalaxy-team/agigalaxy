import path from 'node:path';
import type {CollectionConfig} from 'payload';
import {canEdit,canRead,hasOperatorPermission,isOperator} from '../lib/access';

export const mediaPublication=Symbol('published-page-media');
export const Media:CollectionConfig={
  slug:'media',labels:{singular:'站点图片',plural:'站点图片'},
  admin:{useAsTitle:'alt',defaultColumns:['alt','filename','published','updatedAt']},
  access:{admin:canRead,read:({req})=>isOperator(req.user)&&hasOperatorPermission(req.user,'cms.read')?true:{published:{equals:true}},create:canEdit,
    // Access filters run before Payload replaces an uploaded file. A later hook
    // rejection would be too late for that external filesystem side effect.
    update:({req})=>isOperator(req.user)&&hasOperatorPermission(req.user,'cms.edit')?(req.context.mediaPublication===mediaPublication||hasOperatorPermission(req.user,'cms.publish')?true:{published:{not_equals:true}}):false,
    delete:canEdit},
  upload:{staticDir:path.resolve(/* turbopackIgnore: true */ process.env.GALAXY_CMS_MEDIA_DIR??'media'),mimeTypes:['image/jpeg','image/png','image/webp','image/avif','image/gif'],imageSizes:[{name:'thumbnail',width:480,height:320,fit:'inside',withoutEnlargement:true}]},
  fields:[
    {name:'alt',label:'图片描述',type:'text',required:true,maxLength:400},
    {name:'credit',label:'来源与许可',type:'textarea',maxLength:1600},
    {name:'published',label:'用于已发布页面',type:'checkbox',defaultValue:false,admin:{readOnly:true},access:{create:({req})=>req.context.mediaPublication===mediaPublication,update:({req})=>req.context.mediaPublication===mediaPublication}},
  ],
  hooks:{beforeDelete:[async({req,id})=>{const media=await req.payload.findByID({collection:'media',id,overrideAccess:false,user:req.user,req});if(media.published)throw Error('图片仍用于已发布页面，请先调整页面。');}]},
};
