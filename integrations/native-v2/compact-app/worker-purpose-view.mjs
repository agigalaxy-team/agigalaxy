import {workerComponentResult} from './worker-result.mjs';
import {nativeChoiceUrl} from './browser-choice.mjs';
import {authoredRows,nativeAudienceLabel,nativeStateLabel,a2aParticipantContent} from '../presentation/native-result.mjs';

const workerTools={read:'galaxy_worker_host_read',prepare:'galaxy_worker_host_prepare',execute:'galaxy_worker_host_execute',abort:'galaxy_worker_host_abort_local'};
const terminal=new Set(['completed','failed','canceled','rejected']);
const workerLabels={start:'交给 Worker 处理',send:'交给 Worker 处理',cancel:'停止这次工作',result:'保留这次结果',use:'记录这个包的使用','pack-use':'记录这个包的使用','pack-use-retry':'继续原来的使用记录'};

/** Actual host tools retain exact references, real choice and source leases.
 * This component displays current work and output, and owns only read-only
 * polling/recovery plus unsent editing state. It never approves or resends. */
export function mountWorkerPanel(root,{call,handoff,supportsHandoff=()=>true,displayMode,supportsDisplayMode=()=>true,openLink,supportsOpenLink=()=>false,purpose='worker'}={}){
 const a2a=purpose==='a2a',tool=a2a?{read:'galaxy_a2a_work_read',prepare:'galaxy_a2a_work_prepare',execute:'galaxy_a2a_work_execute',abort:'galaxy_a2a_work_abort_local'}:workerTools;
 const labels=a2a?{...workerLabels,start:'交给所选服务处理',send:'交给所选服务处理',reply:'补充这次工作'}:workerLabels;
 const doc=root.ownerDocument,win=doc.defaultView;
 let current=null,generation=0,intent=0,busy=false,reading=false,destroyed=false,timer=null,choiceTimer=null,expiryTimer=null,browserChoice=null,browserChoiceUrl=null,scope=null;
 let summaryDraft='',outcomeDraft='inconclusive',limitsDraft='',restoredResult=null;
 const el=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 root.className='galaxy-compact';
 const header=el('header'),brand=el('strong','✧ 银河'),back=button('回到原工作',finish),status=el('output','','status');
 back.dataset.return='true';status.setAttribute('aria-live','polite');header.append(brand,back);
 const content=el('section'),review=el('section'),other=el('section'),actions=el('div',undefined,'actions');root.replaceChildren(header,status,content,review,actions,other);
 function button(title,run,secondary=false){const b=el('button',title,secondary?'secondary':undefined);b.type='button';b.addEventListener('click',()=>{if((!busy||b.dataset.return==='true')&&!destroyed){intent++;clearTimeout(timer);Promise.resolve(run()).catch(showError);}});return b;}
 function setBusy(value){busy=value;root.setAttribute('aria-busy',String(value));root.querySelectorAll('button').forEach(b=>{b.disabled=b.dataset.return!=='true'&&(value||b.dataset.waiting==='true');});}
 function readable(node,value){const rows=authoredRows(value);for(const row of rows){const section=el('section',undefined,'worker-content');if(['合计','商'].includes(row.label)&&!row.download)section.classList.add('arithmetic-output');if(row.download){const a=el('a','下载完整内容');a.download='galaxy-worker-content.json';a.href='data:application/json;charset=utf-8,'+encodeURIComponent(row.download);section.append(a);}else section.append(el('h3',row.label),el('p',row.text));node.append(section);}return rows;}
 function diagnostics(value){const detail=el('details');detail.append(el('summary','来源与诊断'),el('p','需要核对准确版本、关联或原操作时，可以下载当前允许的信息。','muted'));
  if(value?.executionAuthority==='peer-reported'||value?.peer?.peer)detail.append(el('p','来源：'+(a2a?'所选服务':'所选 Worker')+'返回的内容。尚未独立验证。','muted'));
  const a=el('a','下载当前信息');a.download='galaxy-worker.json';a.href='data:application/json;charset=utf-8,'+encodeURIComponent(JSON.stringify(value,null,2));detail.append(a);return detail;}
 const associationId=()=>current?.selected?.association?.associationId??current?.preview?.associationId??current?.actionResult?.associationId;
 const peerId=()=>current?.selected?.association?.peerId??current?.preview?.peerId??current?.actionResult?.peerId;
 async function read(id=associationId(),poll=false,{quiet=false}={}){return invoke(tool.read,id?{action:poll?'poll':'get',associationId:id,...(a2a?{peerId:peerId()}:{})}:{action:'list'},{quiet});}
 async function invoke(name,args,{quiet=false,recover=true}={}){
  const background=name===tool.read&&quiet;
  if(destroyed||busy||background&&reading)return;const token=generation,startedIntent=intent;clearTimeout(timer);clearTimeout(choiceTimer);
  // A focus read must not disable the control that the user is entering the
  // iframe to click. A later user action also owns the UI over this read.
  if(background)reading=true;else setBusy(true);if(!quiet)status.textContent='正在取得当前内容…';
  const stale=()=>destroyed||token!==generation||background&&(startedIntent!==intent||busy);
  try{const response=await call(name,args);if(stale())return;
   const data=workerComponentResult(response);
   if(response?.isError)throw Object.assign(new Error(data.error??'worker_host_unavailable'),{associationId:data.associationId??associationId()});
   if(data.resultType==='input_required'){review.replaceChildren(el('p','请在宿主显示的选择中核对内容与范围。'));status.textContent='等待你的选择。';return;}
   if(data.state==='user-choice-needs-browser'){await showBrowserChoice(data);return;}
   if(data.state==='declined'){browserChoice=null;browserChoiceUrl=null;review.replaceChildren();status.textContent='本次操作已取消。';return;}
   receive(data);
   return data;
  }catch(error){if(stale())return;
   const id=error.associationId??associationId();
   // A lost return may have committed. Query that association, never execute
   // the handle or generate another operation merely to make an error disappear.
   if(recover&&name===tool.execute&&id){setBusy(false);status.textContent='正在确认原操作的结果…';return invoke(tool.read,{action:'get',associationId:id,...(a2a?{peerId:peerId()}:{})},{quiet:true,recover:false});}
   showError(error);
  }finally{if(background)reading=false;else if(!destroyed&&token===generation)setBusy(false);}
 }
 function showError(error){clearTimeout(timer);clearTimeout(choiceTimer);browserChoice=null;browserChoiceUrl=null;current=current?{ownerScope:current.ownerScope,viewId:current.viewId}:null;generation++;setBusy(false);
  content.replaceChildren(el('h2','当前内容暂不可用'),el('p','原工作仍保留。回到原工作或重试读取当前允许的内容。'));review.replaceChildren();other.replaceChildren();actions.replaceChildren(button('重试读取',()=>read(error?.associationId)),diagnostics({error:error?.message??'worker_host_unavailable'}));status.textContent='操作暂未完成。';}
 async function showBrowserChoice(data){const prior=browserChoice,preview=current?.preview?.handle?current.preview:data.preview?.handle?data.preview:null,same=prior?.handle===preview?.handle&&browserChoiceUrl===data.url;
  browserChoice=preview;browserChoiceUrl=data.url;
  if(same){scheduleChoice();return;}
  for(const b of root.querySelectorAll('[data-choice-submit]')){b.dataset.waiting='true';b.disabled=true;b.textContent='等待你的选择';}
  const token=generation;
  const box=el('article',undefined,'action-review');box.append(el('p','在本机页面选择后，回到这里会继续同一操作。关闭页面不会批准。'));
  const url=nativeChoiceUrl(data.url),safe=!!url;
  review.querySelector('[data-browser-choice]')?.remove();box.dataset.browserChoice='true';review.append(box);status.textContent='等待你的选择。';
  if(safe&&openLink&&supportsOpenLink()){
   try{const result=await openLink(url);if(destroyed||token!==generation)return;if(!result?.isError){scheduleChoice();return;}}catch{/* Rejection keeps the same reviewed operation. */}
  }
  if(destroyed||token!==generation)return;
  if(safe){box.append(el('p',openLink&&supportsOpenLink()?'当前宿主未打开本机选择页。可以从这里继续同一次选择。':'当前宿主没有提供打开页面的能力。可以从这里继续同一次选择。','muted'));const a=el('a','打开本机选择页');a.href=url;a.target='_blank';a.rel='noopener noreferrer';box.append(a);}
  else{browserChoice=null;browserChoiceUrl=null;box.append(el('p','本次选择地址不可用。请回到原工作重新取得当前内容。','muted'));}
  scheduleChoice();
 }
 async function finish(){clearTimeout(timer);if(busy)return;const refreshed=await read();if(!refreshed)return;const a=refreshed.selected?.association,p=refreshed.preview,r=refreshed.actionResult;
  if(handoff&&supportsHandoff())await handoff({associationId:a?.associationId??p?.associationId??r?.associationId??null,...(a2a?{peerId:peerId()}:{pack:a?.pack??p?.pack??null}),taskId:a?.taskId??null,caseId:a?.caseId??p?.caseId??null,attempt:a?.attempt??p?.attempt??null},refreshed);
  status.textContent='可以回到原工作继续。';
 }
 function resultForm(selected){const state=selected.peer?.peer?.state??selected.peer?.status;
  if(!terminal.has(state)||selected.peer?.resultImportV2?.state==='acknowledged')return;
  const detail=el('details');detail.append(el('summary','保留结果'),el('p','可以编辑实际输出的摘要，并选择本次结果的判断。下一步核对所保存的内容与范围。','muted'));
  const saved=selected.peer?.resultImportV2,event=saved?.draft?.event,display=a2a&&event?a2aParticipantContent({associationId:selected.association.associationId,exact:{payload:event,source:saved.draft.source}}):null;
  const sourceRows=authoredRows(selected.peer?.peer),defaultText=display?.summary??sourceRows.filter(row=>!row.download).map(r=>r.label+'：'+r.text).join('\n\n').slice(0,1200);
  if(display&&!summaryDraft){summaryDraft=display.summary;outcomeDraft=display.reportedOutcome;limitsDraft=display.limitations;}
  const sl=el('label','结果摘要'),s=el('textarea');s.rows=3;s.maxLength=1200;s.value=summaryDraft||defaultText;s.dataset.editor='summary';s.addEventListener('input',()=>{summaryDraft=s.value;});sl.append(s);
  const ol=el('label','结果判断'),o=el('select');o.dataset.editor='outcome';
  const outcomes={inconclusive:'暂不能得出结论',partial:'部分完成',succeeded:'报告完成',failed:'报告未完成',conflicting:'观察有冲突'};
  for(const [v,label]of Object.entries(outcomes)){if(state!=='completed'&&['succeeded','partial'].includes(v))continue;const option=el('option',label);option.value=v;o.append(option);}o.value=outcomeDraft;o.addEventListener('change',()=>{outcomeDraft=o.value;});ol.append(o);
  const ll=el('label','限制或补充（可选）'),l=el('textarea');l.rows=2;l.maxLength=600;l.value=limitsDraft;l.dataset.editor='limits';l.addEventListener('input',()=>{limitsDraft=l.value;});ll.append(l);
  detail.append(sl,ol,ll,button('查看保存内容',()=>{if(!s.value.trim()){s.focus();return;}return invoke(tool.prepare,{action:'result',associationId:selected.association.associationId,...(a2a?{peerId:peerId()}:{}),summary:s.value.trim(),reportedOutcome:o.value,limitations:l.value,visibility:'Private',viewers:[]});}));content.append(detail);
 }
 function receive(response){if(destroyed)return;const next=workerComponentResult(response);
  if(response?.isError){showError(new Error(next.error??'worker_host_unavailable'));return;}
   if(next?.state==='user-choice-needs-browser'){showBrowserChoice(next).catch(showError);return;}
  if(next?.kind!==(a2a?'galaxy-a2a-panel':'galaxy-worker-panel')||next.schemaVersion!==1)return;
  const id=next.selected?.association?.associationId??next.preview?.associationId??next.actionResult?.associationId??null;
  const nextScope=JSON.stringify([next.ownerScope??next.viewId,id]);if(nextScope!==scope){summaryDraft='';outcomeDraft='inconclusive';limitsDraft='';restoredResult=null;scope=nextScope;}
   const visible=value=>{const {viewId:_viewId,checkedAt:_checkedAt,...rest}=value??{};return JSON.stringify(rest);};
  if(!browserChoice&&current&&visible(next)===visible(current)){current=next;if(next.selected?.peer?.peer?.taskId&&!terminal.has(next.selected.peer.peer.state))scheduleRead();return;}
  const active=doc.activeElement?.dataset?.editor,selection=doc.activeElement?.selectionStart;
  const expanded=[...root.querySelectorAll('details[open]')].map(n=>n.querySelector('summary')?.textContent);
  current=next;browserChoice=null;browserChoiceUrl=null;generation++;clearTimeout(timer);clearTimeout(choiceTimer);clearTimeout(expiryTimer);setBusy(false);content.replaceChildren();review.replaceChildren();other.replaceChildren();actions.replaceChildren();
  if(next.availability!=='ready'){content.append(el('h2',a2a?'当前宿主未连接所选服务':'当前宿主未连接 Worker'),el('p','可以回到原工作继续，或在设置中接入已有服务。'));status.textContent='';return;}
  const selected=next.selected,a=selected?.association,peer=selected?.peer,state=peer?.peer?.state??peer?.status;
  if(a){content.append(el('h2',a.purpose??'当前工作'));if(selected.sourceUnavailable)content.append(el('p','原工作当前不可读取。已保留原操作，回执不会恢复旧内容访问。'));
   else if(state!=='completed')content.append(el('p',(state==='working'?'正在处理':nativeStateLabel(state)??'原工作状态待确认')+'。','muted'));
   const output=el('article',undefined,'worker-output'),rows=readable(output,peer?.peer);if(rows.length){content.append(output);}
   else if(terminal.has(state))content.append(el('p','对端没有提供可显示的输出。可以回到原工作处理当前结果。'));
   if(['input-required','auth-required'].includes(state)){content.append(el('p',state==='auth-required'?'所选服务需要处理它的授权；当前身份或凭据不会自动转交。':'对端需要补充内容。'));
    if(a2a){const label=el('label','补充所选内容'),input=el('textarea');input.rows=3;input.maxLength=12000;input.dataset.editor='reply';label.append(input);content.append(label,button('查看补充内容',()=>{if(!input.value.trim()){input.focus();return;}return invoke(tool.prepare,{action:'reply',peerId:peerId(),associationId:a.associationId,text:input.value.trim()});}));}
    else content.append(el('p','回到原聊天补充即可继续。'));}
   if(peer?.peer?.taskId&&!terminal.has(state))actions.append(button('停止这次工作',()=>invoke(tool.prepare,{action:'cancel',associationId:a.associationId,...(a2a?{peerId:peerId()}:{})}),true));
   if(selected.resultReceipt?.state==='acknowledged'||peer?.resultImportV2?.state==='acknowledged')content.append(el('p','这次结果已保留。','muted'));
   if(selected.packUseReceipt?.state==='acknowledged')content.append(el('p','这个包的使用记录已保留。','muted'));
   else if(!a2a&&peer?.resultImportV2?.state==='acknowledged')content.append(button('记录这个包的使用',()=>invoke(tool.prepare,{action:'use',associationId:a.associationId,visibility:'Private',viewers:[]}),true));
   resultForm(selected);content.append(diagnostics(selected));
   // Poll only the already dispatched peer Task while the component is visible.
   // Read-only receipt recovery is implemented by the host read tool.
   if(peer?.peer?.taskId&&!terminal.has(state))timer=setTimeout(()=>{if(doc.visibilityState==='hidden'||root.contains(doc.activeElement)&&doc.activeElement?.dataset?.editor){scheduleRead();return;}void read(a.associationId,true,{quiet:true});},5000);
  }
  if(next.preview){const p=next.preview,box=el('article',undefined,'action-review');box.append(el('h2',labels[p.action]??'继续本次工作'),el('p',p.purpose??'当前工作'));
   const rows=readable(box,a2a&&p.action==='result'?a2aParticipantContent(p):p.exact);if(!rows.length)box.append(el('p',p.action==='cancel'?'请求所选服务停止当前工作。':'这次操作会保留当前工作的使用记录。'));
   box.append(el('p',['start','send','reply','cancel'].includes(p.action)?'由 '+(a2a?p.peerName??'所选服务':p.workerName??p.workerId??'所选服务')+' 处理这里选定的内容。':'保存后'+nativeAudienceLabel(p.visibility,p.recipients)+'可查看。'));
   if(p.exact){const submit=button(p.action==='cancel'?'选择停止':['start','send','reply'].includes(p.action)?'选择发送':'选择保存',()=>invoke(tool.execute,{handle:p.handle,previewHash:p.previewHash}));submit.dataset.choiceSubmit='true';box.append(submit);}
   else box.append(el('p','当前预览不完整，请回到原工作重新取得内容。'));
   box.append(button('取消',()=>invoke(tool.abort,{handle:p.handle}),true),diagnostics(p));review.append(box);
   const lifetime=Date.parse(p.expiresAt)-Date.now();if(Number.isFinite(lifetime)){const expire=()=>{if(destroyed||current?.preview?.handle!==p.handle)return;clearTimeout(choiceTimer);browserChoice=null;browserChoiceUrl=null;for(const b of root.querySelectorAll('[data-choice-submit]')){b.dataset.waiting='true';b.disabled=true;b.textContent='需要更新本次内容';}review.querySelector('[data-browser-choice]')?.remove();status.textContent='本次预览已过期。回到原工作即可重新取得当前内容。';};if(lifetime<=0)expire();else expiryTimer=setTimeout(expire,lifetime);}
  }
  if(next.actionResult){const r=next.actionResult,detail=r.result??r;
   const isLocal=detail.previewDiscarded||detail.localStopped;
   status.textContent=isLocal?'已取消本机预览。':nativeStateLabel(detail.state??detail.peer?.state??r.state)??'已取得当前操作的信息。';
   const output=el('article',undefined,'worker-output');readable(output,detail.peer);if(output.childElementCount)content.append(output);
   if(isLocal)timer=setTimeout(()=>void invoke(tool.read,{action:'list'},{quiet:true}),0);
   else if(r.associationId&&!next.selected)timer=setTimeout(()=>void read(r.associationId,false,{quiet:true}),0);
  }else status.textContent='';
  const associations=next.associations??[];
  if(associations.length){const list=el('details');list.open=!a&&!next.preview;list.append(el('summary',a?'其他工作':'已有工作'));
   for(const row of associations){const item=el('div',undefined,'operation-row');item.append(button(row.purpose??'已有工作',()=>read(row.associationId)),el('p',row.sourceUnavailable?'当前内容暂不可读取。':nativeStateLabel(row.state)??'可继续查看','muted'));list.append(item);}other.append(list);
   if(next.earlierAssociationsAvailable)list.append(el('p','还有较早的工作，可在原聊天按需要取得。','muted'));
  }else if(!a&&!next.preview&&!next.actionResult)content.append(el('h2',a2a?'想让所选服务处理什么？':'想让 Worker 处理什么？'),el('p','在原聊天说明目标，AI 会沿用当前工作准备所需内容。'));
  if(displayMode&&supportsDisplayMode())actions.append(button('展开',()=>displayMode(),true));
  for(const d of root.querySelectorAll('details'))if(expanded.includes(d.querySelector('summary')?.textContent))d.open=true;
  if(active){const editor=root.querySelector('[data-editor="'+active+'"]');editor?.focus();if(typeof selection==='number'&&editor?.setSelectionRange)editor.setSelectionRange(selection,selection);}
  // A reload resumes an already persisted, exact A2A result draft. Preparing
  // another view handle reuses its frozen event, hash and authorization; it
  // cannot send the peer task or save the result without the real choice.
  const saved=selected?.peer?.resultImportV2,e=saved?.draft?.event;
  if(a2a&&!next.preview&&!next.actionResult&&saved?.state==='prepared'&&saved.payloadHash!==restoredResult&&e?.schemaVersion===2&&e.kind==='result-recorded'){
   restoredResult=saved.payloadHash;const shown=a2aParticipantContent({associationId:a.associationId,exact:{payload:e,source:saved.draft.source}});
   timer=setTimeout(()=>void invoke(tool.prepare,{action:'result',peerId:a.peerId,associationId:a.associationId,summary:e.summary,reportedOutcome:e.reportedOutcome,limitations:shown.limitations,
    visibility:saved.authorization?.visibility??'Private',viewers:saved.authorization?.viewers??[]},{quiet:true}),0);
  }
 }
 function scheduleRead(){clearTimeout(timer);timer=setTimeout(()=>{if(destroyed||busy)return;scheduleRead();if(doc.visibilityState!=='hidden'&&!doc.activeElement?.dataset?.editor)void read(associationId(),true,{quiet:true});},5000);}
 function scheduleChoice(){clearTimeout(choiceTimer);if(destroyed||!browserChoice)return;choiceTimer=setTimeout(()=>{if(destroyed||!browserChoice)return;if(busy||doc.visibilityState==='hidden'){scheduleChoice();return;}const p=browserChoice;
   // Continue only this already requested loopback choice. The existing exact
   // gate returns pending without dispatch, and can execute only after its real
   // allow record. Original handle state prevents another peer send after ACK.
   void invoke(tool.execute,{handle:p.handle,previewHash:p.previewHash},{quiet:true});
  },1500);}
 const onFocus=()=>{if(destroyed||busy)return;clearTimeout(timer);timer=setTimeout(()=>{if(destroyed||busy)return;if(browserChoice){const p=browserChoice;void invoke(tool.execute,{handle:p.handle,previewHash:p.previewHash},{quiet:true});}else if(current?.selected)void read(associationId(),false,{quiet:true});},150);};
 const onVisibility=()=>{if(doc.visibilityState==='visible')onFocus();};
 win?.addEventListener('focus',onFocus);doc.addEventListener('visibilitychange',onVisibility);return{receive,refresh:read,close(){destroyed=true;generation++;clearTimeout(timer);clearTimeout(choiceTimer);clearTimeout(expiryTimer);win?.removeEventListener('focus',onFocus);doc.removeEventListener('visibilitychange',onVisibility);current=null;browserChoice=null;browserChoiceUrl=null;summaryDraft='';limitsDraft='';root.replaceChildren();}};
}
