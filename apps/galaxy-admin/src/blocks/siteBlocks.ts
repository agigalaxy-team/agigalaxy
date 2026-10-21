import type {Block,Field} from 'payload';
import {safeHref} from '../lib/content-model.mjs';

const links:Field={name:'links',label:'链接',type:'array',maxRows:12,fields:[
  {name:'label',label:'文字',type:'text',required:true,maxLength:120},
  {name:'href',label:'目标',type:'text',required:true,validate:(value:unknown)=>safeHref(value)||'请使用站内路径或 HTTPS 地址。'},
  {name:'description',label:'说明',type:'textarea',maxLength:400},
]};
export const siteBlocks:Block[]=[
  {slug:'hero',labels:{singular:'页面导语',plural:'页面导语'},fields:[{name:'heading',label:'标题',type:'text',required:true,maxLength:200},{name:'text',label:'导语',type:'textarea',maxLength:1600},links]},
  {slug:'prose',labels:{singular:'正文',plural:'正文'},fields:[{name:'heading',label:'段落标题',type:'text',maxLength:200},{name:'body',label:'正文',type:'textarea',required:true,maxLength:30000,admin:{description:'空行分段；按文字显示。'}}]},
  {slug:'linkList',labels:{singular:'相关入口',plural:'相关入口'},fields:[{name:'heading',label:'标题',type:'text',maxLength:200},links]},
  {slug:'image',labels:{singular:'图片',plural:'图片'},fields:[{name:'media',label:'图片',type:'upload',relationTo:'media',required:true},{name:'caption',label:'图片说明',type:'textarea',maxLength:800}]},
  {slug:'notice',labels:{singular:'服务提示',plural:'服务提示'},fields:[{name:'tone',label:'用途',type:'select',required:true,defaultValue:'information',options:[{label:'说明',value:'information'},{label:'服务影响',value:'service-impact'}]},{name:'title',label:'标题',type:'text',required:true,maxLength:200},{name:'text',label:'内容',type:'textarea',required:true,maxLength:4000}]},
  {slug:'releaseLinks',labels:{singular:'正式发行入口',plural:'正式发行入口'},fields:[{name:'heading',label:'标题',type:'text',maxLength:200},{name:'channel',label:'发行频道',type:'select',required:true,defaultValue:'stable',options:[{label:'正式版',value:'stable'}]},{name:'label',label:'入口文字',type:'text',required:true,defaultValue:'下载银河客户端',maxLength:120}]},
];
