import {authoredRows,nativeStateLabel,nativeAudienceLabel,a2aParticipantContent} from '../../native-v2/presentation/native-result.mjs';
import {nativeChoiceUrl} from '../../native-v2/compact-app/browser-choice.mjs';

const unwrap=r=>{if(r?.resultType==='input_required')return{state:'host-choice-required'};const d=r?.structuredContent??r;if(r?.isError)throw Object.assign(Error(d.error??'a2a_operation_incomplete'),{associationId:d.associationId});return d;};
const plain=v=>String(v??'').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ');
const terminal=new Set(['completed','failed','rejected','canceled']);

export function createNativeA2aMenu({call,select,prompt,info,language,isCurrent,onBack,onReturnWork,onOpenLink,readWorkContext}){
 const label=(cn,en)=>language==='en-US'?en:cn;let version=0,timer=null,closed=false;
 const stop=()=>{clearTimeout(timer);timer=null;},alive=v=>!closed&&isCurrent()&&(v===undefined||version===v);
 const menu=(title,entries,back=home,offset=0)=>{if(!alive())return;stop();const v=++version,routes={};const options=entries.slice(offset,offset+8).map(([title,fn,description=''],i)=>{
  routes[i+1]=()=>{if(alive(v))fn();};return{number:String(i+1),title,description};});if(offset+8<entries.length){options.push({number:'9',title:label('其他内容','More content')});routes[9]=()=>menu(title,entries,back,offset+8);}
  select({title,options,routes,onBack:()=>{if(alive(v))(offset?()=>menu(title,entries,back,offset-8):back)();}});};
 const message=(title,text,back=home)=>{if(!alive())return;stop();const v=++version;info(title,text,()=>{if(alive(v))back();});};
 async function run(fn,done,back=home){stop();const v=++version;info('Galaxy',label('正在取得当前内容…','Reading current content…'),()=>{if(alive(v)){version++;back();}});
  try{const r=unwrap(await fn());if(alive(v))done(r);}catch{if(alive(v))message(label('当前内容暂不可用','Current content unavailable'),label('原工作和原操作仍保留。可以继续原工作或稍后重试读取。','The original work and operation remain. Continue your work or retry the read later.'),back);}}
 function works(done,back,after){void run(async()=>{const page=unwrap(await call('galaxy_work_sources',after?{after}:{})),context=await readWorkContext?.();return{...page,preferredCase:context?.caseId};},page=>{
  const selected=page.items?.find(w=>w.caseId===page.preferredCase);if(selected)return done(selected);
  if(!page.items?.length&&!page.nextCursor)return message(label('选择实际工作','Choose actual work'),label('当前没有本人可用的尝试。先继续原工作，再将选定内容交给已有服务。','There is no current owned Attempt. Continue the original work before sending selected content.'),back);
  menu(label('选择实际工作','Choose actual work'),[...(page.items??[]).map(w=>[plain(w.title),()=>done(w),plain(w.summary)]),...(page.nextCursor?[[label('其他工作','Other work'),()=>works(done,back,page.nextCursor)]]:[])],back);
 },back);}
 function start(peer){const back=()=>peerHome(peer);works(work=>void run(async()=>({view:unwrap(await call('galaxy_work_read',{caseId:work.caseId})),context:await readWorkContext?.()}),({view,context})=>{
  const selected=attempt=>{const send=text=>prepare({peerId:peer.id,action:'send',caseId:work.caseId,attemptId:attempt.id,attemptVersion:attempt.version,...(attempt.taskId?{taskId:attempt.taskId}:{}),text},back),prepared=context?.a2a;
   if(context?.caseId===work.caseId&&prepared?.peerId===peer.id&&prepared.attemptId===attempt.id&&prepared.attemptVersion===attempt.version&&typeof prepared.text==='string'&&prepared.text.trim())return send(prepared.text);
   edit(label('这次需要所选服务处理的内容','Selected content for this service'),attempt.strategy??'',send,back);};
  if(view.selectableAttempts?.length===1)return selected(view.selectableAttempts[0]);
  menu(plain(work.title)+'\n'+label('选择这次正在进行的尝试','Choose this actual Attempt'),(view.selectableAttempts??[]).map(a=>[plain(a.strategy)||label('当前尝试','Current Attempt'),()=>selected(a)]),back);
 },back),back);}
 function edit(title,value,done,back){stop();const v=++version;prompt({title,placeholder:value,onCancel:back,onConfirm:text=>{if(alive(v)&&String(text).trim())done(String(text).trim());else if(alive(v))back();}});}
 function prepare(input,back){void run(()=>call('galaxy_a2a_work_prepare',input),data=>{
  if(!data.preview)return detail(input.peerId,input.associationId,back);const p=data.preview;
  const render=()=>menu(plain(p.purpose)+'\n\n'+authoredRows(p.action==='result'?a2aParticipantContent(p):p.exact).filter(r=>!r.download).map(r=>r.label+'：'+plain(r.text)).join('\n\n')+'\n\n'+label('所选服务：','Selected service: ')+plain(p.peerName)+(p.action==='result'?'\n'+nativeAudienceLabel(p.visibility,p.recipients):''),[
   [label(input.action==='cancel'?'选择停止':input.action==='result'?'选择保留':'选择发送',input.action==='cancel'?'Choose stop':input.action==='result'?'Choose save':'Choose send'),()=>void perform(p,back)],
   [label('来源与诊断','Source and diagnostics'),()=>message(label('准确内容','Exact content'),JSON.stringify(p.exact,null,2),render)],
   [label('返回编辑','Return to editing'),back],
  ],back);render();
 },back);}
 async function perform(p,back){stop();const v=++version;let opened=false;info(label('继续本次选择','Continue this choice'),label('正在打开本机选择…','Opening local choice…'),()=>{if(alive(v)){version++;stop();back();}});
  const tick=async()=>{if(!alive(v))return;if(Date.parse(p.expiresAt)<=Date.now())return message(label('本次选择已过期','This choice expired'),label('原工作保留。重新读取当前工作即可继续。','The original work remains. Read it again to continue.'),back);
   try{const r=unwrap(await call('galaxy_a2a_work_execute',{handle:p.handle,previewHash:p.previewHash}));if(!alive(v))return;
    if(r.state==='user-choice-needs-browser'){const url=nativeChoiceUrl(r.url);if(!url)throw Error('invalid_choice');if(!opened){opened=true;if(onOpenLink)try{await onOpenLink(url);}catch{}
     if(!alive(v))return;info(label('等待你的选择','Waiting for your choice'),label('本机页会显示所选内容与接收范围；完成后继续同一原操作。','The local page shows the selected content and recipients. Choosing continues this original operation.')+'\n\n'+url,()=>{if(alive(v)){version++;stop();back();}});}timer=setTimeout(tick,1500);timer.unref?.();return;}
    if(r.state==='declined')return message(label('已取消本次选择','Choice cancelled'),label('没有发送新的内容。可以继续原工作。','No new content was sent. Continue your work.'),back);
    if(r.state==='host-choice-required')return message(label('等待宿主选择','Waiting for host choice'),label('请完成宿主当前显示的真实选择，随后从原工作查询；不会自动批准。','Complete the actual host choice, then inspect the original work.'),back);
    stop();detail(p.peerId,p.associationId,back);
   }catch{stop();if(alive(v))detail(p.peerId,p.associationId,back);}
  };await tick();}
 function detail(peerId,associationId,back=home){if(!associationId)return back();void run(()=>call('galaxy_a2a_work_read',{action:'get',peerId,associationId}),data=>{
  const selected=data.selected;if(!selected)return back();const a=selected.association,link=selected.peer,state=link?.peer?.state??link?.status;
  if(selected.sourceUnavailable)return message(label('原内容当前不可读','Original content unavailable'),selected.resultReceipt?.state==='acknowledged'?label('原结果已保留。回执不恢复旧正文访问，可以继续原工作。','The original result was saved. The receipt does not restore content access.'):label('原操作仍保留；当前范围不允许读取旧内容。','The original operation remains; its old content is not currently readable.'),onReturnWork);
  const render=()=>menu(plain(a.purpose)+'\n\n'+(state==='completed'?'':(nativeStateLabel(state)??label('原操作尚待确认','Original operation unconfirmed'))+'\n')+
   authoredRows(link?.peer).filter(r=>!r.download).map(r=>r.label+'：'+plain(r.text)).join('\n\n')+(link?.resultImportV2?.state==='acknowledged'?'\n\n'+label('这次结果已保留。','This result was saved.'):' '),[
    ...(['input-required','auth-required'].includes(state)?[[label('补充所选内容','Supply selected content'),()=>edit(label('补充本次内容','Follow-up content'),'',text=>prepare({action:'reply',peerId,associationId,text},()=>detail(peerId,associationId,back)),render)]]:[]),
    ...(terminal.has(state)&&link?.resultImportV2?.state!=='acknowledged'?[[label('保留这次结果','Save this result'),()=>saveResult(selected,render)]]:[]),
    ...(link?.peer?.taskId&&!terminal.has(state)?[[label('停止这次工作','Stop this work'),()=>prepare({action:'cancel',peerId,associationId},render)]]:[]),
    [label('回到原工作','Return to original work'),onReturnWork],
    [label('来源与诊断','Source and diagnostics'),()=>message(label('准确来源','Exact source'),JSON.stringify(selected,null,2),render)],
   ],back);render();
  if(link?.peer?.taskId&&!terminal.has(state)){const v=version;const poll=()=>{timer=setTimeout(async()=>{if(!alive(v))return;try{const fresh=unwrap(await call('galaxy_a2a_work_read',{action:'poll',peerId,associationId}));
    if(!alive(v))return;if(fresh.selected?.sourceUnavailable||JSON.stringify(fresh.selected?.peer?.peer)!==JSON.stringify(link.peer))detail(peerId,associationId,back);else poll();
   }catch{if(alive(v))detail(peerId,associationId,back);}},5000);timer.unref?.();};poll();}
 },back);}
 function saveResult(selected,back){const a=selected.association,state=selected.peer.peer.state,summary=authoredRows(selected.peer.peer).filter(r=>!r.download).map(r=>r.label+'：'+r.text).join('\n\n').slice(0,1200);
  const draft={summary,reportedOutcome:'inconclusive',limitations:'',visibility:'Private',viewers:[]};
  const render=()=>menu(label('保留这次结果','Save this result')+'\n\n'+plain(draft.summary)+'\n\n'+label('可见范围：仅自己','Visibility: only me'),[
   [label('编辑实际输出摘要','Edit the observed output'),()=>edit(label('实际输出摘要','Observed output summary'),draft.summary,text=>{draft.summary=text;render();},render)],
   [label('选择本次结果判断','Choose this result outcome'),()=>menu(label('这次对原工作的结果','Result for the original work'),[['inconclusive','暂不能得出结论','Inconclusive'],['partial','部分完成','Partial'],['succeeded','报告完成','Reported success'],['failed','报告未完成','Reported failure'],['conflicting','观察有冲突','Conflicting']].filter(([v])=>state==='completed'||!['succeeded','partial'].includes(v)).map(([v,cn,en])=>[label(cn,en),()=>{draft.reportedOutcome=v;render();}]),render),nativeStateLabel(draft.reportedOutcome)??draft.reportedOutcome],
   [label('查看保存内容','Review saved content'),()=>prepare({action:'result',peerId:a.peerId,associationId:a.associationId,...draft},back)],
  ],back);render();}
 function peerHome(peer){void run(()=>call('galaxy_a2a_work_read',{action:'list',peerId:peer.id}),data=>menu(plain(peer.name??peer.id),[
  ...(data.associations??[]).map(a=>[plain(a.purpose),()=>detail(peer.id,a.associationId,()=>peerHome(peer)),a.sourceUnavailable?label('当前内容不可读','Current content unavailable'):nativeStateLabel(a.state)]),
  [label('将当前内容交给这项服务','Send current content to this service'),()=>start(peer)],
 ],home),home);}
 function home(){void run(()=>call('galaxy_a2a_peers',{}),page=>{const rows=Array.isArray(page)?page:page.items??[];
  if(!rows.length)return message(label('当前没有已接入的服务','No connected service'),label('继续原工作；需要外部服务时，由宿主明确选择已配置端点和授权。','Continue your work. The host must explicitly select a configured endpoint and its authority.'),onBack);
  menu(label('交给已有服务处理','Use an existing service'),rows.map(p=>[plain(p.name??p.id),()=>peerHome(p),plain(p.endpoint)]),onBack);
 },onBack);}
 return{home,detail,close(){closed=true;version++;stop();}};
}
