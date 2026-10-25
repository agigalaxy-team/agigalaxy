import {showExactChoice} from './exact-choice.mjs';
import {createLegacyWorkSelection} from './legacy-work-selection.mjs';
import {authoredRows,nativeStateLabel} from '../../../packages/galaxy-edge-mcp/src/native-v2/interaction/presentation.mjs';

// v1 imports keep their original generated Result and Consent. Separate only
// the exact known provenance lines, bound to this actual association/response.
export function readableLegacyA2aResult(preview,link){
 let payload;try{payload=JSON.parse(preview.payloadJson);}catch{return undefined;}
 const peer=link?.peer,limits=payload?.limitations,known=[
  'External peer report; no independent execution or capability verification.',
  `A2A state: ${peer?.state}; association: ${link?.id}; response SHA-256: ${peer?.responseHash}`,
  'Artifact hashes identify received content/references. Referenced URLs were not fetched; this is not a Proof.'
 ];
 if(payload?.kind!=='result'||payload.caseId!==link?.caseId||payload.attemptId!==link?.attemptId
  ||!Array.isArray(limits)||limits.length!==3||!/^[0-9a-f]{64}$/.test(peer?.responseHash??'')
  ||limits.some((line,i)=>line!==known[i]))return payload;
 return {...payload,limitations:[]};
}

export function createA2aMenu({controller,select,prompt,info,language,isCurrent,onBack,availableScopes=[],readWorkContext,onReturnWork}){
 const label=(cn,en)=>language==='en-US'?en:cn;
 const plain=(value,max=12000)=>String(value??'').replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,max);
 let generation=0,view=0,timer=null,peersById=new Map();
 const stop=()=>{clearTimeout(timer);timer=null;view++;};
 const leave=()=>{stop();generation++;controller.cancel();onBack();};
 const returnWork=()=>{stop();generation++;controller.cancel();(onReturnWork??onBack)();};
 const message=(text,back=home)=>{if(!isCurrent())return;stop();const current=view;info(label('所选服务','Selected service'),text,()=>{if(isCurrent()&&current===view){view++;back();}});};
 function menu(title,entries,back=home,offset=0){if(!isCurrent())return;stop();const current=view,routes={},activate=fn=>()=>{if(isCurrent()&&current===view){stop();fn();}};
  const options=entries.slice(offset,offset+8).map(([title,fn,description=''],i)=>{routes[i+1]=activate(fn);return{number:String(i+1),title,description};});
  if(offset+8<entries.length){options.push({number:'9',title:label('下一页','Next page'),description:''});routes[9]=activate(()=>menu(title,entries,back,offset+8));}
  select({title,options,routes,onBack:activate(offset?()=>menu(title,entries,back,offset-8):back)});
 }
 async function run(work,done,back=home){stop();const version=++generation;message(label('正在读取或准备','Reading or preparing'),()=>{generation++;controller.cancel();back();});
  try{const value=await work();if(isCurrent()&&version===generation)done(value);}catch(error){if(isCurrent()&&version===generation)message(plain(error.message),back);}
 }
 function form(title,fields,done,back=home,draft={},index=0){if(!isCurrent())return;stop();if(index===fields.length)return done(draft);
  const [key,name,initial='',maximum=12000]=fields[index],current=view;
  const activate=fn=>value=>{if(isCurrent()&&current===view){stop();fn(value);}};
  prompt({title:title+'\n'+name,value:String(draft[key]??initial),placeholder:'',onCancel:activate(()=>index?form(title,fields,done,back,draft,index-1):back()),
   onConfirm:activate(value=>{if(String(value).length>maximum)return message(label('内容过长，请保留本次需要发送的部分。','Keep only the content needed for this request.'),()=>form(title,fields,done,back,draft,index));draft[key]=String(value);form(title,fields,done,back,draft,index+1);})});
 }
 const workSelection=createLegacyWorkSelection({controller,menu,form,message,run,label,plain,readWorkContext});
 const stateName=link=>link.resultImport?.state==='acknowledged'?label('这次结果已保留','This result was saved')
  :({'submitted':label('已发出，正在处理','Sent; processing'),'completed':label('结果已返回','Result returned'),'message-only':label('收到消息','Message received'),'auth-required':label('所选服务需要补充授权','The selected service needs authorization')}[link.peer?.state]
   ??nativeStateLabel(link.peer?.state??link.status)??label('原操作的结果尚未确认','The original outcome is unconfirmed'));
 const content=link=>authoredRows(link.peer,{limit:40}).filter(row=>!row.download).map(row=>row.label+'：'+plain(row.text)).join('\n\n');
 async function source(link){const current=await controller.getCase(link.caseId);
  if(current.caseId!==link.caseId||current.state==='withdrawn'||!current.events.some(event=>event.kind==='attempt'&&event.id===link.attemptId))throw Error(label('原工作或尝试当前不可读。原操作仍保留，不能沿用旧内容继续发送。','The original work or Attempt is unavailable. The original operation remains retained; cached content cannot authorize another send.'));
  return current;
 }
 async function read(peer,associationId,{poll=false}={}){const input={peerId:peer.id,associationId};let link=await controller.readA2a('get',input);let current=await source(link);
  if(poll&&link.peer?.taskId&&!['completed','failed','rejected','canceled'].includes(link.peer.state)){link=await controller.readA2a('poll',input);current=await source(link);}
  if(availableScopes.includes('consent')&&link.resultImport&&link.resultImport.state!=='acknowledged'){
   // Reads only the exact original event. A missing event remains the same
   // original import; it never creates a new Result or resends external text.
   await controller.readA2a('reconcile',input);link=await controller.readA2a('get',input);current=await source(link);
  }
  return{link,current};
 }
 function confirm(input,back,link){void run(()=>controller.prepareA2a(input),preview=>{
  let submitted=false;const current=generation,cancel=()=>{generation++;controller.cancel();back();};
  showExactChoice({preview,title:input.kind==='result'?label('保留这次结果与范围','Save this result and scope'):input.kind==='cancel'?label('请求停止这次远端工作','Request that this remote work stop'):label('发送这次内容给所选服务','Send this content to the selected service'),
   allowLabel:input.kind==='result'?label('保留这次结果','Save this result'):input.kind==='cancel'?label('请求停止','Request stop'):label('发送所选内容','Send selected content'),
   select,info,language,readBeforeChoice:true,isCurrent:()=>isCurrent()&&generation===current&&!submitted,onCancel:cancel,
   readableContent:input.kind==='result'?readableLegacyA2aResult(preview,link):undefined,
   onConfirm:async value=>{if(!isCurrent()||submitted||current!==generation)return;submitted=true;stop();const version=++generation;message(label('正在处理本次选择','Processing this choice'),cancel);
    try{const result=await controller.executeA2a(preview,value);if(isCurrent()&&version===generation){
      const id=result?.id??input.associationId;if(id)return detail(peersById.get(input.peerId)??{id:input.peerId,endpoint:preview.endpoint},id);
      message(label('这次结果已保留，可以继续原工作。','This result was saved. Continue the original work.'),back);
    }}catch{if(isCurrent()&&version===generation)message(label('原操作已保留，正在确认结果。返回后会读取同一次操作。','The original operation is retained. Return to read its current outcome.'),back);}
   }});
 },back);}
 function textInput(input,back,{initial='',work,peer}={}){form(label('本次要发送的内容','Content to send this time'),[['text',label('只包含此服务需要的文字','Include only the text this service needs'),initial]],
  value=>void run(async()=>{if(work)await workSelection.reread(work);if(input.associationId)await read(peer,input.associationId);return value;},v=>confirm({...input,text:v.text},back),back),back);}
 function start(peer){const back=()=>peerHome(peer);
  workSelection.select(work=>void run(async()=>{const fresh=await workSelection.reread(work),current=await controller.getCase(work.caseId),context=await readWorkContext?.();
   if(!current.events.some(e=>e.kind==='attempt'&&e.id===fresh.attempt.id))throw Error(label('所选尝试已不可读','The selected Attempt is unavailable'));
   const selected=context?.caseId===fresh.caseId&&context?.a2a?.peerId===peer.id&&context.a2a.attemptId===fresh.attempt.id?context.a2a.text:undefined;
   return{fresh,selected};
  },({fresh,selected})=>{const input={peerId:peer.id,kind:'send',caseId:fresh.caseId,attemptId:fresh.attempt.id};
   if(typeof selected==='string'&&selected.trim())return confirm({...input,text:selected},back);
   textInput(input,back,{work:fresh});
  },back),back,{mode:'attempt'});
 }
 function importResult(peer,link){const back=()=>detail(peer,link.id),input={peerId:peer.id,kind:'result',associationId:link.id};
  menu(label('这份结果的可见性','Visibility of this result'),[
   [label('仅自己','Only me'),()=>confirm({...input,visibility:'Private',viewers:[]},back,link)],
   [label('已有接收成员','Existing recipients'),()=>form(label('接收成员','Recipients'),[['viewers',label('接收成员的稳定身份，逗号分隔','Recipient stable identities, comma separated')]],value=>confirm({...input,visibility:'Private',viewers:value.viewers.split(/[,，]/).map(v=>v.trim()).filter(Boolean)},back,link),back)],
   [label('公开已选结果','Public selected result'),()=>confirm({...input,visibility:'Public',viewers:[]},back,link)],
  ],back);
 }
 function detail(peer,associationId){const back=()=>detail(peer,associationId),input={peerId:peer.id,associationId};
  const render=({link,current})=>{const title=current.events.find(event=>event.kind==='case')?.title??peer.name??label('原工作','Original work'),entries=[];
   if(link.status==='observed'&&['input-required','auth-required'].includes(link.peer?.state))entries.push([label('补充所需内容','Provide requested input'),()=>textInput({...input,kind:'reply'},back,{peer})]);
   if(link.peer?.taskId&&['submitted','working','input-required','auth-required'].includes(link.peer.state))entries.push([label('请求停止远端工作','Request remote work stop'),()=>confirm({...input,kind:'cancel'},back)]);
   if(availableScopes.includes('consent')&&link.status==='observed'&&['completed','failed','rejected','canceled'].includes(link.peer?.state)&&link.resultImport?.state!=='acknowledged')entries.push([label('保留这次结果','Save this result'),()=>importResult(peer,link)]);
   if(['unknown','dispatching'].includes(link.status)&&!link.peer?.taskId)entries.push([label('重新读取原操作','Read the original operation again'),back,label('尚未取得远端任务引用，不能自动重发。','No remote task reference is known. Sending again is unavailable.')]);
   entries.push([label('回到原工作','Return to original work'),returnWork],[label('查看来源与完整内容','Inspect source and full content'),()=>message(JSON.stringify({endpoint:peer.endpoint,peerPrincipal:peer.peerPrincipal,...link},null,2),back)]);
   menu(plain(title)+'\n'+stateName(link)+(content(link)?'\n\n'+content(link):''),entries,()=>tasks(peer));
   const token=view,signature=value=>JSON.stringify([value.link.status,value.link.peer,value.link.resultImport?.state,value.current.version]);
   if(link.peer?.taskId&&['submitted','working','input-required','auth-required'].includes(link.peer.state)){
    const watch=()=>{timer=setTimeout(async()=>{if(!isCurrent()||token!==view)return;try{const latest=await read(peer,associationId,{poll:true});if(!isCurrent()||token!==view)return;
      if(signature(latest)!==signature({link,current}))render(latest);else watch();
     }catch{if(isCurrent()&&token===view)menu(label('当前任务暂不可读','Current task unavailable'),[[label('重试读取原工作','Retry reading the original work'),back],[label('回到原工作','Return to original work'),returnWork]],()=>tasks(peer));}},5000);timer.unref?.();};watch();
   }
  };
  void run(()=>read(peer,associationId,{poll:true}),render,()=>tasks(peer));
 }
 function tasks(peer,offset=0){void run(async()=>{const links=await controller.readA2a('list',{peerId:peer.id}),rows=[];
  for(const link of links.slice(offset,offset+8)){try{const current=await source(link);rows.push({link,title:current.events.find(event=>event.kind==='case')?.title??peer.name});}catch{rows.push({link,title:label('原工作当前不可读','Original work unavailable'),unavailable:true});}}
  return{rows,more:links.length>offset+8};
 },({rows,more})=>{const entries=rows.map(row=>[plain(row.title),()=>detail(peer,row.link.id),row.unavailable?'':stateName(row.link)]);
  if(more)entries.push([label('其他已有工作','Other existing work'),()=>tasks(peer,offset+8)]);
  menu(label('此服务的已有工作','Existing work for this service')+(!rows.length?'\n'+label('还没有已有工作。','No existing work yet.') : ''),entries,offset?()=>tasks(peer,offset-8):()=>peerHome(peer));
 },()=>peerHome(peer));}
 function peerHome(peer){menu(plain(peer.name),[
  [label('处理当前工作','Help with current work'),()=>start(peer)],
  [label('查看已有工作','View existing work'),()=>tasks(peer)],
  [label('查看服务来源','Inspect service source'),()=>message(JSON.stringify(peer,null,2),()=>peerHome(peer))],
 ],home);}
 function home(){void run(()=>controller.readA2a('peers'),peers=>{peersById=new Map(peers.map(peer=>[peer.id,peer]));menu(label('选择可用服务','Choose an available service'),peers.map(peer=>[plain(peer.name),()=>peerHome(peer)]),leave);},leave);}
 return{open:home,close(){stop();generation++;controller.cancel();}};
}
