import {createExistingRecordSelection} from './existing-record-selection.mjs';

export function createDataExportMenu({controller,select,prompt,info,language,isCurrent,onBack}){
 const label=(cn,en)=>language==='en-US'?en:cn,plain=value=>String(value??'').replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,2000);
 const names={assistance:label('求助与协作','Help and collaboration'),context:label('共享材料','Shared materials'),proof:label('CI 来源','CI source'),capsule:label('方法','Method'),builder:label('开放节点','Open node'),moderation:label('治理事项','Governance matter'),
  'forum-post-version':label('社区文章','Community post'),'forum-reply':label('社区回复','Community reply'),'builder-support':label('节点支持记录','Node support record'),'choice-snapshot':label('已作选择','Saved choice'),recruitment:label('招募','Recruitment'),project:label('项目','Project'),contact:label('联系授权','Contact authorization'),'personal-summary':label('本人简介','Personal summary'),task:label('求助工作','Help task'),case:label('工作记录','Work record'),evidence:label('原材料','Source material'),verification:label('检查记录','Verification record')};
 let generation=0;
 const back=()=>{generation++;controller.cancel();onBack();};
 function menu(title,entries,leave=home,offset=0){if(!isCurrent())return;const current=++generation,routes={},activate=fn=>()=>{if(current===generation&&isCurrent()){generation++;fn();}};
  const options=entries.slice(offset,offset+8).map(([title,fn,description=''],i)=>{routes[i+1]=activate(fn);return{number:String(i+1),title,description};});
  if(offset+8<entries.length){options.push({number:'9',title:label('继续查看','More content'),description:''});routes[9]=activate(()=>menu(title,entries,leave,offset+8));}
  select({title,options,routes,onBack:activate(offset?()=>menu(title,entries,leave,offset-8):leave)});
 }
 function message(text,leave=home){if(!isCurrent())return;const current=++generation;info(label('导出资料','Export data'),text,()=>{if(current===generation&&isCurrent()){generation++;leave();}});}
 async function run(work,done,leave=home){const current=++generation;info(label('导出资料','Export data'),label('正在处理','Working'),()=>{if(isCurrent()&&current===generation){generation++;controller.cancel();leave();}});
  try{const value=await work();if(isCurrent()&&current===generation)done(value);}catch(error){if(isCurrent()&&current===generation)message(plain(error.message),leave);}
 }
 const records=createExistingRecordSelection({controller,menu,message,run,label,plain});
 function destination(specification,title,ticket){if(!isCurrent())return;const current=++generation;
  prompt({title:label('保存到本机','Save locally')+'\n'+plain(title)+'\n'+label('输入现有目录的绝对路径；会在其中创建这次导出的文件夹。','Enter an existing absolute directory. This export gets its own folder within it.'),placeholder:'',
   onCancel:()=>{if(current===generation&&isCurrent()){generation++;home();}},onConfirm:value=>{if(current!==generation||!isCurrent())return;generation++;
    const directory=String(value).trim();if(!directory)return destination(specification,title,ticket);
    let originalTicket=ticket;
    void run(async()=>{originalTicket??=await controller.readDataExport('create',specification);return{original:originalTicket,saved:await controller.saveDataExport(originalTicket.id,directory)};},({original,saved})=>menu(label('已保存到本机','Saved locally')+'\n'+plain(saved.directory)+'\n'+`${saved.files} ${label('个文件','files')} · ${saved.totalRows} ${label('条记录','records')}`,[[label('继续原工作','Continue original work'),back],
      [label('查看导出来源与格式','Inspect export source and format'),()=>message(JSON.stringify({ticket:original,export:saved},null,2),()=>home())],
      [label('结束此次下载权限','End this download access'),()=>void run(()=>controller.readDataExport('revoke',{id:original.id}),()=>message(label('此次下载权限已结束。','This download access ended.')))]
    ],back),()=>destination(specification,title,originalTicket));
   }});
 }
 function view(kind){records.select(kind,item=>destination({datasets:['authorized-views'],views:[{kind,id:item.id,...(item.versionId?{versionId:item.versionId}:{})}]},item.title),()=>kinds());}
 let supported=[];
 function kinds(){menu(label('选择需要保存的内容','Choose the content to save'),supported.map(kind=>[names[kind]??plain(kind),()=>view(kind)]));}
 function knownReference(kind){if(!kind)return menu(label('已有内容引用的类型','Type of existing content reference'),supported.map(kind=>[names[kind]??plain(kind),()=>knownReference(kind)]));
  const current=++generation;prompt({title:label('使用已有内容引用','Use an existing content reference')+'\n'+(names[kind]??plain(kind)),placeholder:'UUID',onCancel:home,onConfirm:value=>{if(current!==generation||!isCurrent())return;generation++;destination({datasets:['authorized-views'],views:[{kind,id:String(value).trim()}]},names[kind]??kind);}});
 }
 function home(){if(!isCurrent())return;void run(()=>controller.readDataExport('specification'),specification=>{
   supported=specification.viewKinds??[];
   menu(label('导出资料到本机','Export data locally'),[
    [label('保存本人资料','Save my data'),()=>destination({datasets:specification.datasets},label('所选服务中的本人资料','My data held by the selected service')),label('含私有资料，请选择自己的保存位置。','Includes private data; choose your own destination.')],
    ...(supported.length?[[label('保存当前可读内容','Save currently readable content'),kinds],[label('使用已有内容引用','Use an existing content reference'),()=>knownReference()]]:[])
   ],back);
  },back);}
 return{open:home};
}
