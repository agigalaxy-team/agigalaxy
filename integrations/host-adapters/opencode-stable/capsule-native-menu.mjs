import {nativeAudienceLabel} from '../../../packages/galaxy-edge-mcp/src/native-v2/interaction/presentation.mjs';
import {nativeChoiceUrl} from '../../native-v2/compact-app/browser-choice.mjs';

const plain=value=>String(value??'').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ');
const unwrap=r=>{if(r?.resultType==='input_required')return{state:'host-choice-required'};const v=r?.structuredContent??(r?.content?.[0]?.text?JSON.parse(r.content[0].text):r);if(r?.isError||v?.error)throw Object.assign(Error(v?.error??'current_content_unavailable'),{code:v?.error});return v;};
const same=(a,b)=>a?.id===b?.id&&a?.version===b?.version;
const latest=rows=>[...new Map((rows??[]).filter(r=>!r.supersededInVisibleHistory).sort((a,b)=>a.version-b.version).map(r=>[r.id,r])).values()];
const failureText={capsule_work_current_success_required:'所选工作当前没有可用的成功结果。请在原工作继续，结果准备后再整理方法。',
 capsule_work_current_result_required:'这项结果已变化，请重新选择当前工作中的结果。',capsule_work_verification_required:'这项实际结果还没有可引用的验证记录。请先在原工作完成验证，再回来接续。',
 capsule_application_required:'这项结果尚无对应的实际应用记录。先记录已发生的应用，再引用已有验证。',capsule_source_permission_required:'所选方法包含其他人的来源，现有许可尚未覆盖本次内容或许可证。可以继续原工作取得相应许可。',
 capsule_new_case_required:'请从实际使用这份方法的其他工作选择结果。原方法自己的来源不算新的应用。',capsule_not_applicable:'这份方法的来源或维护状态已变化，当前不能新记录应用。已有历史仍按原权限读取。',
 capsule_work_identity_changed:'当前身份或连接已变化。旧预览不会继续提交，请重新取得当前允许的内容。'};

// This menu uses the current Native v2 capability rather than the legacy
// professional controller. The Native runtime retains exact operations.
export function createNativeCapsuleMenu({call,select,prompt,info,isCurrent,onBack,onReturnWork=onBack,openLink,language='zh-CN',readWorkContext}){
 const zh=language!=='en-US',label=(cn,en)=>zh?cn:en;let version=0,closed=false,timer=null;
 const alive=v=>!closed&&isCurrent()&&(v===undefined||v===version);
 const stop=()=>{if(timer)clearTimeout(timer);timer=null;};
 const menu=(title,entries,back=onBack,offset=0)=>{if(!alive())return;stop();const v=++version,routes={};const options=entries.slice(offset,offset+8).map(([title,fn,description='',disabled=false],i)=>{
  routes[i+1]=()=>{if(alive(v)&&!disabled)fn();};return{number:String(i+1),title,description,disabled};});
  if(offset+8<entries.length){options.push({number:'9',title:label('其他内容','More content')});routes[9]=()=>{if(alive(v))menu(title,entries,back,offset+8);};}
  select({title,options,routes,onBack:()=>{if(alive(v)){version++;stop();if(offset)menu(title,entries,back,Math.max(0,offset-8));else back();}}});};
 const message=(title,text,back=onBack)=>{if(!alive())return;const v=++version;info(title,text,()=>{if(alive(v))back();});};
 async function run(fn,done,back=onBack){const v=++version;stop();info(label('方法','Methods'),label('正在取得当前内容…','Reading current content…'),()=>{if(alive(v)){version++;stop();back();}});
  try{const result=unwrap(await fn());if(alive(v))done(result);}catch(e){if(alive(v))message(label('暂时无法继续','Cannot continue yet'),failureText[e.code]??label('当前内容暂不可用。可以继续原工作，稍后再读取当前内容。','Current content is unavailable. Continue the original work or retry later.'),back);}}
 function edit(title,value,done,back){const v=++version;prompt({title,placeholder:title,value:plain(value),onCancel:()=>{if(alive(v))back();},onConfirm:text=>{if(alive(v))done(String(text).trim());}});}
 function chooseWork(action,done,back=onBack,after,excludeCaseId){void run(async()=>{const page=unwrap(await call('galaxy_capsule_work_sources',{action,...(after?{after}:{})}));
   page.items=(page.items??[]).filter(item=>item.caseId!==excludeCaseId);
   const context=!after?await readWorkContext?.():null;return{...page,preferredCase:context?.caseId};},page=>{
  const current=page.items?.find(w=>w.caseId===page.preferredCase);if(current)return done(current);
  if(!page.items?.length&&!page.nextCursor)return message(label('选择实际工作','Choose actual work'),label('当前没有可用于这次操作的工作。可以先回到原工作继续。','No current work is available for this action. Continue the original work first.'),back);
  const render=()=>menu(label('选择实际工作','Choose actual work'),[...(page.items??[]).map(w=>[plain(w.title),()=>done(w),plain(w.summary)]),
   ...(page.nextCursor?[[label('其他工作','Other work'),()=>chooseWork(action,done,back,page.nextCursor,excludeCaseId)]]:[])],back);render();
 },back);}
 function chooseResult(work,action,done,back){void run(()=>call('galaxy_capsule_work_read',{caseId:work.caseId}),view=>{
  const results=latest(view.results).filter(r=>r.provenance==='native-v2'&&(action==='publish'?r.reportedOutcome==='succeeded':r.actorId===view.subjectId)
   &&view[r.origin?.kind==='attempt'?'attempts':'interventions']?.some(o=>same(o,r.origin)&&o.actorId===r.actorId));
  if(!results.length)return message(plain(work.title),label('这项工作当前没有对应的可用结果。请继续原工作，或重新选择。','This work has no current eligible result. Continue it or choose another.'),back);
  const selected=r=>done({...work,view,result:r,verificationRefs:work.results?.find(x=>same(x,r))?.verificationRefs??[]});
  if(results.length===1)return selected(results[0]);
  menu(plain(work.title)+'\n'+label('选择本次实际结果','Choose this actual result'),results.map(r=>[plain(r.summary),()=>selected(r),({succeeded:'已完成',partial:'部分完成',failed:'未完成',inconclusive:'尚无结论',conflicting:'结果有冲突'}[r.reportedOutcome]??r.reportedOutcome)]),back);
 },back);}
 function chooseAudience(draft,render){menu(label('谁可以查看这份内容？','Who can see this content?'),[
  [label('仅自己','Only me'),()=>{draft.visibility='Private';draft.viewers=[];render();}],
  [label('所有人','Everyone'),()=>{draft.visibility='Public';draft.viewers=[];render();}],
  [label('已有接收成员','Existing recipients'),()=>void run(()=>call('galaxy_profile_names',{subjectIds:draft.viewers??[]}),names=>{
   if(!names.items?.length)return message(label('接收成员','Recipients'),label('这份当前草稿没有已选接收成员。可以保留仅自己或在原工作明确选定成员。','This current draft has no selected recipients. Keep it private or select actual recipients in the original work.'),render);
   menu(label('沿用当前接收成员','Use current recipients'),[[label('自己与当前所选成员','Me and the selected members'),()=>{draft.visibility='Private';render();},names.items.map(n=>n.displayName??n.subjectId).join('、')]],render);
  },render)],
 ],render);}
 function fieldEditor(draft,fields,render){menu(label('方法内容与条件','Method content and conditions'),fields.map(([key,title])=>[title,()=>edit(title,Array.isArray(draft.method[key])?draft.method[key].join('\n'):draft.method[key],text=>{
  draft.method[key]=Array.isArray(draft.method[key])?text.split(/\r?\n/).map(v=>v.trim()).filter(Boolean):text;render();},render),plain(Array.isArray(draft.method[key])?draft.method[key].join('\n'):draft.method[key])]),render);}
 function publicationEditor(selected,detail){const r=selected.result,o=selected.view[r.origin.kind==='attempt'?'attempts':'interventions'].find(f=>same(f,r.origin));
  const prior=detail?.version,draft={visibility:detail?.disclosure?.visibility??'Private',viewers:detail?.disclosure?.viewers??[],method:{
   title:prior?.title??selected.title,problemPattern:prior?.problemPattern??selected.summary,solutionStrategy:prior?.solutionStrategy??o.strategy??o.description??'',
   environment:prior?.environment??(o.environment?.name&&o.environment?.version?{name:o.environment.name,version:o.environment.version}:{name:'unknown',version:'unknown'}),
   tools:prior?.tools??[],skills:prior?.skills??[],mcpRefs:prior?.mcpRefs??[],verificationMethod:prior?.verificationMethod??('工作中报告的结果：'+plain(r.summary)),
   limitations:prior?.limitations??[plain(r.limitations)||'这项工作没有提供额外限制说明。'],capabilityId:prior?.capabilityId??'',applicableScope:prior?.applicableScope??o.inputScopeSummary??selected.summary,license:prior?.license??''}};
  const render=()=>menu(label('整理这份方法','Prepare this method'),[
   [label('方法内容','Method content'),()=>fieldEditor(draft,[['title','标题'],['problemPattern','适用问题'],['solutionStrategy','解决方法']],render),plain(draft.method.title)+' · '+plain(draft.method.solutionStrategy)],
   [label('适用条件与限制','Conditions and limits'),()=>fieldEditor(draft,[['applicableScope','适用范围'],['limitations','限制'],['verificationMethod','验证说明']],render)],
   [label('环境与工具','Environment and tools'),()=>menu(label('环境与工具','Environment and tools'),[
    [label('环境','Environment'),()=>edit('环境名称',draft.method.environment.name,v=>{draft.method.environment.name=v;edit('环境版本',draft.method.environment.version,x=>{draft.method.environment.version=x;render();},render);},render)],
    ...[['tools','工具'],['skills','技能'],['mcpRefs','连接工具']].map(([key,title])=>[title,()=>fieldEditor(draft,[[key,title]],render),draft.method[key].join('、')])],render)],
   [label('用途与许可证','Capability and license'),()=>menu(label('用途与许可证','Capability and license'),[
    [label('能力标识','Capability identifier'),()=>edit('适用能力标识',draft.method.capabilityId,v=>{draft.method.capabilityId=v;render();},render),draft.method.capabilityId],
    [label('许可证','License'),()=>edit('本次内容的许可证标识',draft.method.license,v=>{draft.method.license=v;render();},render),draft.method.license]],render)],
   [label('可见范围','Visibility'),()=>chooseAudience(draft,render),nativeAudienceLabel(draft.visibility,draft.viewers)],
   [label('保存方法','Save method'),()=>{if(!draft.method.capabilityId||!draft.method.license)return message(label('补充方法用途','Complete method scope'),label('请补充能力标识与许可证，再保存这份方法。已有来源许可只会在当前许可证与范围相符时沿用。','Enter the capability identifier and license. Existing source permissions are reused only when they match the current license and scope.'),render);
    prepareAndChoose({action:'publish',caseId:selected.caseId,resultRef:{id:r.id,version:r.version},...(detail?{capsuleId:detail.capsuleId}:{}),method:draft.method,visibility:draft.visibility,viewers:draft.viewers},render);}],
   [label('本次采用的工作内容','Selected work content'),()=>message(label('本次采用的工作内容','Selected work content'),plain(selected.title)+'\n\n'+plain(selected.summary)+'\n\n'+plain(r.summary),render)],
  ],()=>detail?open(detail.capsuleId,detail.versionId):home());render();}
 function publish(detail){chooseWork('publish',w=>chooseResult(w,'publish',selected=>publicationEditor(selected,detail),()=>publish(detail)),detail?()=>open(detail.capsuleId,detail.versionId):onBack);}
 function application(detail,action){const back=()=>open(detail.capsuleId,detail.versionId);chooseWork(action,w=>chooseResult(w,action,selected=>{
  if(action==='reverify'&&!selected.verificationRefs.length)return message(label('接续再次验证','Continue reverification'),failureText.capsule_work_verification_required,back);
  const show=prior=>{const draft={visibility:'Private',viewers:[],note:prior?.record?.note??'',adoptedParts:prior?.record?.adoptedParts??[],environmentDifference:prior?.record?.environmentDifference??null};
  const render=()=>menu(label(action==='apply'?'记录实际应用':'接续再次验证',action==='apply'?'Record actual application':'Continue reverification'),[
   ...(action==='apply'?[[label('实际采用了什么？','What did you actually use?'),()=>edit(label('说明本次实际采用的方法部分','Describe the parts actually used'),draft.note,text=>{draft.note=text;draft.adoptedParts=text?[text]:[];render();},render),draft.note||plain(selected.title)]]
    :[[label('原来的采用部分','Originally adopted parts'),()=>message(label('沿用原应用','Use original application'),draft.adoptedParts.map(plain).join('\n'),render),draft.adoptedParts.map(plain).join('；')],
      [label('补充验证说明','Add verification note'),()=>edit(label('补充本次验证说明，可沿用原说明','Add a verification note or retain the original'),draft.note,text=>{draft.note=text;render();},render),draft.note]]),
   [label('环境差异','Environment difference'),()=>edit(label('补充已观察到的环境差异','Add observed environment differences'),draft.environmentDifference??'',text=>{draft.environmentDifference=text||null;render();},render),label('沿用原工作已记录的环境；未知时保留未知。','Use the original recorded conditions; unknown remains unknown.')],
   [label('可见范围','Visibility'),()=>chooseAudience(draft,render),nativeAudienceLabel(draft.visibility,draft.viewers)],
   [label('保存这次记录','Save this record'),()=>{if(!draft.note)return message(label('说明实际采用部分','Describe the actual use'),label('请说明本次实际采用了哪部分方法。结果与原工作来源会沿用已有记录。','Describe the parts actually used. The actual result and origin come from existing work.'),render);
    prepareAndChoose({action,caseId:selected.caseId,resultRef:{id:selected.result.id,version:selected.result.version},capsuleId:detail.capsuleId,versionId:detail.versionId,
     note:draft.note,adoptedParts:draft.adoptedParts,...(draft.environmentDifference?{environmentDifference:draft.environmentDifference}:{}),verificationRefs:selected.verificationRefs,
     visibility:draft.visibility,viewers:draft.viewers},render);}],
   [label('本次方法与工作','Selected method and work'),()=>message(label('本次方法与工作','Selected method and work'),plain(detail.version.title)+' · '+label('版本 ','Version ')+detail.version.version+'\n\n'+plain(selected.title)+'\n'+plain(selected.result.summary),render)],
  ],back);render();};
  if(action==='reverify')return void run(()=>call('galaxy_capsule_work_application',{capsuleId:detail.capsuleId,versionId:detail.versionId,caseId:selected.caseId,resultRef:{id:selected.result.id,version:selected.result.version}}),show,back);
  show(null);
 },back),back,undefined,detail.version.sourceResolution.caseId);}
 function prepareAndChoose(input,back){void run(()=>call('galaxy_capsule_work_prepare',input),preview=>void perform(preview,back),back);}
 async function perform(preview,back){stop();const v=++version;let choiceDeadline=null,inFlight=false;
  info(label('保存当前内容','Save current content'),label('正在打开本次选择…','Opening this choice…'),()=>{if(alive(v)){version++;stop();back();}});
  const tick=async()=>{if(!alive(v)||inFlight)return;if(choiceDeadline!==null&&Date.now()>=choiceDeadline){stop();return message(label('这次选择已过期','This choice expired'),label('原操作保留在本机。可以从尚待接续取得同一次内容的当前选择。','The original operation is retained locally. Continue its same content from pending continuations.'),pending);}inFlight=true;try{const raw=await call('galaxy_capsule_work_execute',{handle:preview.handle});if(!alive(v))return;const r=unwrap(raw);
   if(r.state==='user-choice-needs-browser'){
    const url=nativeChoiceUrl(r.url);if(!url)throw Error('Invalid local choice');
    choiceDeadline??=r.expiresAt;
    if(!timer){if(openLink)try{await openLink(url);}catch{/* The actual safe link remains available. */}
     if(!alive(v))return;info(label('等待你的选择','Waiting for your choice'),label('请在本机选择页核对这份内容与范围，完成选择后会沿用原操作接续。','Review this content and scope on the local choice page. Completion continues the same original operation.')+'\n\n'+url,()=>{if(alive(v)){stop();void tick();}});}
    timer=setTimeout(tick,1500);timer.unref?.();return;
   }
   stop();if(r.state==='host-choice-required')return message(label('等待宿主选择','Waiting for host choice'),label('请完成宿主当前显示的实际选择。原操作已保留，随后可以从“尚待接续”继续查询。','Complete the host’s actual current choice. The original operation is retained for later continuation.'),back);
   if(r.state==='declined')return message(label('已取消','Cancelled'),label('这次内容没有获得新的授权。可以返回编辑或继续原工作。','This content did not receive new authorization. Edit it or continue the original work.'),back);
   if(r.state==='acknowledged'){const payload=preview.payloadJson?JSON.parse(preview.payloadJson):{},outcome=({succeeded:'已完成',partial:'部分完成',failed:'未完成',inconclusive:'尚无结论',conflicting:'结果有冲突'}[payload.outcome]??payload.outcome);
    const summary=preview.action==='publish'?[plain(payload.title??preview.title),...(payload.version?[label('版本 ','Version ')+payload.version]:[])].filter(Boolean).join(' · '):[outcome,plain(payload.note)].filter(Boolean).join('\n');
    return menu(label(preview.action==='publish'?'方法已保存':'这次使用已记录',preview.action==='publish'?'Method saved':'Use recorded')+(summary?'\n'+summary:''),[[label('回到原工作','Return to original work'),onReturnWork],[label('阅读所保存的方法','Read the saved method'),()=>open(r.receipt.capsuleId,r.receipt.versionId)]],onReturnWork);}
   recover(preview);
  }catch(e){stop();if(alive(v))recover(preview,failureText[e.code]);}finally{inFlight=false;}};
  await tick();
 }
 function recover(preview,notice){menu(label('结果尚未确认','Outcome not confirmed'),[
  [label('重试读取结果','Retry reading result'),()=>void run(()=>call('galaxy_capsule_work_status',{handle:preview.handle}),value=>message(label('原操作结果','Original operation'),value.state==='acknowledged'?label('原操作已完成。可以继续原工作。','The original operation completed. Continue the original work.'):value.state==='prepared'?label('这份内容尚未提交。可以继续原工作，稍后重新整理。','This content has not been submitted. Continue the original work and prepare it later.'):label('原操作仍未确认；没有重新提交。','The original operation is still unconfirmed; it was not resubmitted.'),onReturnWork),onReturnWork),notice??label('原操作已保留，读取同一次结果。','The original operation is retained; read this same result.')],
  [label('回到原工作','Return to original work'),onReturnWork],
 ],onReturnWork);}
 function pending(){void run(()=>call('galaxy_capsule_work_pending',{}),page=>menu(label('尚待接续','Pending continuations'),(page.items??[]).map(p=>[plain(p.title),()=>p.state==='prepared'?void perform(p,pending):void run(()=>call('galaxy_capsule_work_status',{handle:p.handle}),r=>message(plain(p.title),r.state==='acknowledged'?label('原操作已完成。可以继续原工作。','The original operation completed. Continue your work.'):label('原操作仍未确认；本次只查询，没有重新提交。','The original operation is still unconfirmed; this read did not resubmit it.'),pending),pending),p.state==='prepared'?label('继续同一次内容与范围；不会重新准备。','Continue the same content and scope without preparing again.'):label('读取原操作结果。','Read the original outcome.')]),home),home);}
 function home(after){void run(()=>call('galaxy_capsule_v2_query',{limit:5,...(after?{after}:{})}),page=>menu(label('方法','Methods'),[
  ...(page.items??[]).map(m=>[plain(m.title),()=>open(m.capsuleId,m.versionId),plain(m.problemPattern)]),
  [label('整理工作中的方法','Prepare a method from work'),()=>publish()],
  [label('尚待接续','Pending continuations'),pending],
  ...(page.nextAfter?[[label('其他方法','Other methods'),()=>home(page.nextAfter)]]:[]),
 ],onBack));}
 function open(capsuleId,versionId){void run(async()=>{const detail=unwrap(await call('galaxy_capsule_v2_read',{capsuleId,...(versionId?{versionId}:{})}));
   if(detail.ownerControl){const versions=unwrap(await call('galaxy_capsule_v2_versions',{capsuleId,limit:20}));detail.disclosure=versions.items?.find(v=>v.versionId===detail.versionId)?.disclosure;}
   return detail;},detail=>{
  if(!detail.version)return message(label('这份方法当前不可读','This method is currently unavailable'),label('来源或可见范围已变化。可以继续原工作或查看其他方法。','Its source or visibility changed. Continue the original work or read another method.'),home);
  const v=detail.version,notices=[...(detail.synthetic===true?[label('合成示例','Synthetic example')]:[]),...(detail.deprecated?[label('此版本已弃用','This version is deprecated')]:[]),...(detail.securityIssue?[label('此版本有未解除的安全问题','This version has an unresolved security issue')]:[])];
  const content=[notices.join(' · '),label('解决方法','Solution method')+'\n'+plain(v.solutionStrategy),label('适用问题','Applicable problem')+'\n'+plain(v.problemPattern),label('适用范围','Applicable scope')+'\n'+plain(v.applicableScope)].filter(Boolean).join('\n\n');
  const render=()=>menu(plain(v.title)+' · '+label('版本 ','Version ')+v.version,[
   [label('阅读全文','Read method'),()=>message(plain(v.title)+' · '+label('版本 ','Version ')+v.version,content,render)],
   [label('适用条件与限制','Conditions and limits'),()=>message(label('适用条件与限制','Conditions and limits'),[label('环境','Environment')+'\n'+`${plain(v.environment?.name)} ${plain(v.environment?.version)}`,label('验证说明','Verification note')+'\n'+plain(v.verificationMethod),label('限制','Limitations')+'\n'+(v.limitations??[]).map(plain).join('\n'),label('许可证','License')+'\n'+plain(v.license)].join('\n\n'),render)],
   ...(detail.newApplicationAllowed===true&&v.schemaVersion===2?[[label('记录实际应用','Record actual application'),()=>application(detail,'apply')],[label('接续再次验证','Continue reverification'),()=>application(detail,'reverify')]]:[]),
   ...(detail.ownerControl&&v.schemaVersion===2?[[label('修订这份方法','Revise this method'),()=>publish(detail)]]:[]),
   [label('来源与具体版本','Source and exact version'),()=>message(label('来源与具体版本','Source and exact version'),JSON.stringify(detail,null,2),render)],
   [label('尚待接续','Pending continuations'),pending],[label('回到原工作','Return to original work'),onReturnWork],
  ],home);message(plain(v.title)+' · '+label('版本 ','Version ')+v.version,content,render);
 },home);}
 return{open,home,publish,close(){closed=true;version++;stop();}};
}
