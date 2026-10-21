import type {GlobalConfig} from 'payload';
import {canRead,canEdit} from '../lib/access';
import {safeHref} from '../lib/content-model.mjs';
export const SiteSettings:GlobalConfig={
  slug:'site-settings',label:'站点设置',
  access:{read:canRead,update:canEdit,readVersions:canRead},
  versions:{drafts:true,max:30},
  fields:[
    {name:'siteTitle',label:'站点名称',type:'text',required:true,defaultValue:'银河',maxLength:120},
    {name:'description',label:'站点介绍',type:'textarea',maxLength:600},
    {name:'footerLinks',label:'页尾入口',type:'array',maxRows:12,fields:[{name:'label',label:'文字',type:'text',required:true,maxLength:100},{name:'href',label:'目标',type:'text',required:true,validate:(value:unknown)=>safeHref(value)||'请使用站内路径或 HTTPS 地址。'}]},
  ],
};
