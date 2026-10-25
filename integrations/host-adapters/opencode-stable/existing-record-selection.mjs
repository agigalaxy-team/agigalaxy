import {nativeStateLabel} from '../../../packages/galaxy-edge-mcp/src/native-v2/interaction/presentation.mjs';

// These are current reads through the same configured controller. A selected
// locator never adds read rights; the original consumer validates it again.
export function createExistingRecordSelection({controller,menu,message,run,label,plain}){
 const names={assistance:label('求助与协作','Help and collaboration'),context:label('共享材料','Shared materials'),proof:label('CI 来源','CI source'),capsule:label('方法','Method'),builder:label('开放节点','Open node'),moderation:label('治理事项','Governance matter')};
 async function list(kind,{after,query='',limit=7,assistanceId,subjectId,assistanceView}={}){
  const paging={limit,...(after?{after}:{})};let page;
  if(kind==='assistance'&&controller.queryAssistance)page=await controller.queryAssistance({...paging,query,...(assistanceView?{view:assistanceView}:{})});
  else if(kind==='context'&&controller.queryContext&&assistanceId)page=await controller.queryContext(assistanceId);
  else if(kind==='capsule'&&controller.queryCapsules)page=await controller.queryCapsules({...paging,query});
  else if(kind==='builder'&&controller.queryBuilders)page=await controller.queryBuilders({...paging,query});
  else if(kind==='moderation'&&controller.queryModeration)page=await controller.queryModeration(paging);
  else if(kind==='proof'&&controller.querySearch)page=await controller.querySearch({type:'proof',query:{...paging,query,...(subjectId?{subjectId}:{})}});
  else throw Error(label('当前连接尚不能列出这类可读内容。按需要接续对应读取，或使用已保存的内容引用。','This connection cannot list currently readable content of this kind. Select its read access or use an existing saved reference.'));
  return{items:(page.items??[]).map((item,index)=>({kind,id:item.source?.id??item.capsuleId??item.builderId??item.grantId??item.assistanceId??item.id,
   ...(kind==='capsule'&&item.versionId?{versionId:item.versionId}:{}),
   title:plain(item.title??item.name??item.request?.title??item.assistanceTitle??item.reason??item.summary??names[kind]+' '+(index+1)),
   description:plain(item.summary??item.scope??item.agreedScope??nativeStateLabel(item.state??item.status)??''),record:item})),next:page.nextAfter??page.nextCursor??null};
 }
 function select(kind,done,back,{after,query='',assistanceId,subjectId,assistanceView,filter=()=>true}={}){
  // v1 Context query takes the existing assistance UUID, not a paging object.
  // Select that currently readable parent before listing its material grants.
  if(kind==='context'&&!assistanceId)return select('assistance',parent=>select('context',done,back,{assistanceId:parent.id}),back);
  void run(()=>list(kind,{after,query,assistanceId,subjectId,assistanceView}),page=>{
  const entries=page.items.filter(item=>item.id&&filter(item.record)).map(item=>[item.title,()=>void run(async()=>{
    const fresh=await list(kind,{after,query,assistanceId,subjectId,assistanceView}),current=fresh.items.find(value=>value.id===item.id&&value.versionId===item.versionId&&filter(value.record));
    if(!current)throw Error(label('所选来源已经变化或不可读，请重新选择当前内容。','The selected source changed or is unavailable. Choose its current content.'));
    return current;
   },done,back),item.description]);
  if(page.next)entries.push([label('其他可读内容','Other readable content'),()=>select(kind,done,back,{after:page.next,query,assistanceId,subjectId,assistanceView,filter})]);
  menu(label('选择已有','Choose existing ')+names[kind]+(!entries.length?'\n'+label('当前没有可读内容。','No content is currently readable.') : ''),entries,back);
 },back);}
 return{select,list};
}
