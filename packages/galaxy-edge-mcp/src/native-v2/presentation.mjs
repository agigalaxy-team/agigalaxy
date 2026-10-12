// Human text and exact machine data share one result without making people
// inspect transport records. This module has no authority or side effects.
import {communityResultLines,bookmarkResultLines} from './community-presentation.mjs';
const labels = {title:'标题',summary:'内容',text:'内容',description:'说明',purpose:'用途',goal:'目标',currentSituation:'目前情况',requestedScope:'需要的帮助',limitations:'限制',message:'消息',name:'名称',displayName:'名称',fileName:'文件',filename:'文件',reason:'说明',resultSummary:'结果',notes:'补充说明',value:'结果',values:'输入',inputCount:'输入数量',operation:'处理方式',delayMs:'所选等待（毫秒）',selectedDelayMs:'所选等待（毫秒）',about:'简介',claimedCapabilities:'自报能力',problemPattern:'适用问题',solutionStrategy:'解决方法',applicableScope:'适用范围',verificationMethod:'验证方法',tools:'工具',skills:'技能',mcpRefs:'连接工具',license:'许可证',approach:'方法',strategy:'方法',problem:'问题说明',attemptedApproaches:'已有尝试',scope:'范围',note:'补充说明',environmentDifference:'环境差异',issuer:'登录服务',externalSubject:'外部账户',providerId:'登录服务标识',modelFamily:'模型系列',inputScopeSummary:'输入范围',permissionScope:'权限范围',requestedFields:'所选字段',reasonCode:'追查事项',actions:'允许的操作'};
labels.adoptedParts='实际采用的部分';
labels.proposal='协助说明';
labels.reportedOutcome='结果判断';labels.outcome='结果判断';
export function nativeConnectionMessage(status,language='zh-CN'){
 const zh=language!=='en-US',label=(cn,en)=>zh?cn:en;
 if(status.connected)return label('当前设备已连接银河，可以继续当前工作。','This device is connected to Galaxy. Continue the current work.');
 if(status.connectionError==='current_device_control_required')return label('当前设备的连接权限已变化。请在仍获准的设备上接续身份；原工作和本机资料保留。','This device no longer has the required connection permission. Continue the identity from an authorized device; original work and local material are retained.');
 if(status.connectionError)return label('暂时无法恢复已选服务的连接。原身份、使用范围和工作保留，可以重试当前连接。','The selected service connection cannot be restored right now. Your identity, selected scope and work are retained; retry this connection.');
 return status.identity?label('这台设备已有稳定身份。按当前工作需要连接服务即可继续。','This device has a stable identity. Connect to the service when the current work needs it.'):
  label('这台设备尚未准备身份。按当前工作需要创建或接续已有身份即可。','This device has no prepared identity. Create or continue an existing identity when the current work needs it.');
}
const resultNames={succeeded:'完成',partial:'部分完成',failed:'未完成',inconclusive:'暂不能得出结论',conflicting:'观察有冲突'};
// The existing A2A v2 schema retains a fixed provenance prefix in limitations.
// Separate only that exact known prefix, tied to this association and response
// digest. The original payload remains untouched in structured diagnostics.
export function a2aParticipantContent(preview){
 const payload=preview?.exact?.payload??preview?.draft?.event,source=preview?.exact?.source??preview?.draft?.source;
 if(payload?.schemaVersion!==2||payload.kind!=='result-recorded'||typeof payload.limitations!=='string'
  ||!/^[0-9a-f-]{36}$/.test(preview.associationId??'')||!/^[0-9a-f]{64}$/.test(source?.responseHash??''))return payload??preview?.exact??preview;
 const prefix=`External A2A participant report; no independent Verification, acceptance or Resolution. Association ${preview.associationId}; response SHA256 ${source.responseHash}; artifacts remain selected summaries/hashes in the private local journal.`;
 if(payload.limitations!==prefix&&!payload.limitations.startsWith(prefix+' '))return payload;
 return{...payload,limitations:payload.limitations.slice(prefix.length).trim()};
}
const contentLists=new Set(['limitations','claimedCapabilities','tools','skills','mcpRefs','permissionScope','requestedFields','actions','adoptedParts']);
export const nativeStateLabel = state => ({accepted:'已接受',acknowledged:'已完成',declined:'已取消',prepared:'待操作',pending:'正在处理',unknown:'正在确认原操作的结果',absent:'原操作尚未接受',active:'进行中',paused:'已暂停',stopped:'已停止',completed:'对端报告已完成',working:'对端正在处理',failed:'未完成',canceled:'对端报告已取消',rejected:'对端已拒绝','input-required':'对端需要补充内容',revoked:'已撤销',expired:'已过期',conflict:'内容需要核对',connected:'已连接','session-local':'本机连接可用','no-session':'尚未连接','user-choice-needs-browser':'等待你的选择','original-operation-needs-reconciliation':'正在核对原操作','foreground-fallback':'请在当前聊天继续处理','suspended-host':'当前宿主未运行此工作'}[state] ?? null);
export const nativeOperationLabel = name => ({galaxy_native_initialize:'创建本机身份',galaxy_native_connect:'连接银河',galaxy_native_authorize:'分享本次内容',galaxy_chat_agent_grant:'允许 AI 帮助处理这段对话',galaxy_device_offer:'接续已有身份',galaxy_device_approve:'允许新设备接续身份',galaxy_device_accept:'在这台设备接续身份',galaxy_summary_sync_choice:'设置私人笔记同步',galaxy_summary_sync_resolve:'保存合并后的笔记',galaxy_summary_cloud_delete:'删除云端笔记',galaxy_watch_start:'让 AI 持续关注这段工作',galaxy_watch_resume:'恢复关注',galaxy_watch_pause:'暂停关注',galaxy_worker_host_execute:'处理这次工作',galaxy_help_action_execute:'执行本次选择',galaxy_native_notification_enable:'开启本机通知',galaxy_native_notification_permission:'允许本机通知'}[name] ?? (/device/.test(name)?'调整设备':/identity/.test(name)?'调整身份':/context/.test(name)?'分享材料':/assistance/.test(name)?'处理协作':/publish/.test(name)?'发布本次内容':/cancel|stop/.test(name)?'停止这次操作':'继续本次操作'));
export const nativeAudienceLabel = (value,recipients=[]) => ['Private','private'].includes(value)&&recipients.length?'自己与所选接收方':({Public:'所有人',public:'所有人',Private:'仅自己',private:'仅自己',Shared:'所选成员',shared:'所选成员','selected-peer':'所选 Worker'}[value] ?? '本次选择的范围');

// The repository's reference Worker has this explicit output contract. Other
// schemas keep their authored fields; this is presentation, not recalculation.
function referenceArithmetic(value){return value&&!Array.isArray(value)&&typeof value==='object'
 &&Object.keys(value).length===5&&Object.keys(value).every(key=>['state','operation','value','inputCount','workerVersion'].includes(key))
 &&value.state==='completed'&&['sum','quotient'].includes(value.operation)&&value.workerVersion==='0.1.0'
 &&typeof value.value==='number'&&Number.isFinite(value.value)&&Number.isInteger(value.inputCount)&&value.inputCount>0&&value.inputCount<=64
 ?{label:value.operation==='sum'?'合计':'商',text:String(value.value)}:null;}
function referenceArtifact(object){return object.name==='Selected arithmetic output'&&Array.isArray(object.parts)&&object.parts.some(part=>{
 const text=part?.text??part?.content?.value;if(typeof text!=='string')return false;try{return !!referenceArithmetic(JSON.parse(text));}catch{return false;}
});}

export function authoredRows(value,{limit=80,maxText=48000}={}) {
 const rows=[],seen=new Set();
 function walk(object,depth=0){
  if(!object||depth>8||rows.length>=limit)return;
  if(Array.isArray(object)){for(const item of object)walk(item,depth+1);return;}
  if(typeof object!=='object')return;
  const arithmetic=referenceArithmetic(object);if(arithmetic){const signature=arithmetic.label+'\0'+arithmetic.text;if(!seen.has(signature)){seen.add(signature);rows.push(arithmetic);}return;}
  for(const [key,item]of Object.entries(object)){
   if(rows.length>=limit)break;
   if(key==='name'&&referenceArtifact(object))continue;
   if(labels[key]&&(typeof item==='string'&&item.trim()||typeof item==='number'&&Number.isFinite(item)||key==='values'&&Array.isArray(item)&&item.every(value=>typeof value==='number'&&Number.isFinite(value))||contentLists.has(key)&&Array.isArray(item)&&item.length&&item.every(value=>typeof value==='string'))){
    let structured;
    if(typeof item==='string'&&/^[\s]*[[{]/.test(item)){try{const parsed=JSON.parse(item);if(parsed&&typeof parsed==='object')structured=parsed;}catch{/* Ordinary authored text is preserved. */}}
    if(structured){const signature='structured\0'+item;if(!seen.has(signature)){seen.add(signature);const before=rows.length;walk(structured,depth+1);if(rows.length===before)rows.push({label:labels[key],text:'结构化内容已返回。可下载完整内容，在当前工作中使用。'});rows.push({label:'完整内容',text:'保留原始字段与格式。',download:item});}continue;}
    const text=key==='operation'?({sum:'求和',quotient:'除法'}[item]??String(item)):['reportedOutcome','outcome'].includes(key)?resultNames[item]??String(item):Array.isArray(item)?item.join('、'):String(item),signature=labels[key]+'\0'+text;
    if(!seen.has(signature)){seen.add(signature);rows.push({label:labels[key],text:text.slice(0,maxText)});}
   }else if(key==='payloadJson'&&typeof item==='string'){try{walk(JSON.parse(item),depth+1);}catch{/* Opaque bytes remain in the exact diagnostic. */}}
   else if(!/(?:id|ids|hash|proof|signature|authorizationContext|receipt|secret|token|key|revision|version)$/i.test(key))walk(item,depth+1);
  }
 }
 walk(value);return rows;
}

export function describeNativeChoice(name,input) {
 const preview=input?.preview??input??{};let contactPayload;
 if(name==='galaxy_contact_work_execute'&&typeof preview.payloadJson==='string'){try{contactPayload=JSON.parse(preview.payloadJson);}catch{/* Opaque bytes stay in diagnostics; no fields are guessed. */}}
 const payload=contactPayload??(/^galaxy_a2a_(?:work_)?execute$/.test(name)&&['result',undefined].includes(preview.action)?a2aParticipantContent(preview):preview.exact?.payload??preview.payload??preview);
 const a2aResultAuthorization=name==='galaxy_a2a_execute'&&preview.kind==='result'?preview.authorization:null;
 const title=name==='galaxy_a2a_execute'&&preview.kind==='result'?'保留这次结果'
  :name==='galaxy_help_execute_action'&&preview.kind==='task-event'&&payload.event?.kind==='apply'?'发送这份协助说明'
  :name==='galaxy_capsule_work_execute'?({publish:'保存这份方法',apply:'记录这次实际应用',reverify:'记录这次再次验证',reference:'在原工作引用这份方法'}[preview.action]??'继续这份方法')
  :name==='galaxy_a2a_work_execute'?({send:'发送本次所选内容',reply:'发送这次补充内容',cancel:'停止这次工作',result:'保留这次结果'}[preview.action]??'继续本次选择')
  :name==='galaxy_contact_work_execute'?({send:'发起这次联系',accept:'接受这次交流',decline:'谢绝这次交流',withdraw:'撤回这次联系'}[preview.action]??'处理这次联系')
  :(name==='galaxy_panel_action_execute'||name==='galaxy_help_action_execute'||name==='galaxy_help_execute_action')?({'publish-task':'发布这份请求','task-event':'更新这次求助','participation-propose':'申请这次参与','participation-event':'更新参与情况','context-grant':'分享这些材料','context-event':'调整材料范围'}[preview.kind]??nativeOperationLabel(name)):nativeOperationLabel(name),rows=authoredRows(name==='galaxy_contact_work_execute'?{title:payload.roomTitle??preview.relatedContact?.title,
   purpose:({conversation:'交流想法',reuse:'了解复用',collaboration:'一起做事',recruitment:'了解招募'}[payload.purpose??preview.relatedContact?.purpose]),note:payload.note||preview.relatedContact?.note,goal:payload.context?.kind==='ephemeral'?payload.context.title:undefined}
   :/^galaxy_a2a_(?:work_)?execute$/.test(name)&&(preview.action??preview.kind)==='result'?payload:preview);
 const visibility=a2aResultAuthorization?.visibility??preview.visibility??payload.visibility??input.visibility;
 const recipients=a2aResultAuthorization?.viewers??preview.recipientNames??preview.recipients??preview.viewers??preview.recipientIds??payload.viewers??input.viewers;
 const scope=input?.mode??preview.mode;
 const sections=[];
 if(name==='galaxy_native_initialize')sections.push({label:'保存在这台设备',text:'稳定身份和设备密钥。连接服务与外发内容按需要另行选择。'});
 if(name==='galaxy_native_connect')sections.push({label:'这次连接',text:'使用当前设备接入所选银河服务；私人笔记和原工作全文不会由这次连接上传。'});
 if(/device_management_confirm|identity_device_native_confirm/.test(name))sections.push({label:'这次变更',text:'撤销所选设备的身份控制与绑定，保留历史证明。'});
 if(/device_management_stop|identity_device_native_stop_retry/.test(name))sections.push({label:'这次变更',text:'停止本机等待并保留原操作证明；这不会确认远端已取消。'});
 if(/identity_group/.test(name))sections.push({label:'当前身份的选择',text:'这次选择仅代表当前身份，其他成员仍需各自选择。'});
 if(name==='galaxy_contact_work_execute')sections.push({label:'这次联系',text:preview.action==='send'?'向这里显示的接收方发送联系内容，等待对方回应。':preview.action==='accept'?'接受这次交流并进入双方的普通对话。':preview.action==='decline'?'谢绝这次交流。':'撤回自己发起的这次联系。'});
 if(name==='galaxy_help_execute_action'&&preview.kind==='task-event'&&payload.event?.kind==='apply')sections.push({label:'这次发送',text:'把协助说明发送给求助发起者，等待对方回应。这次发送不代表已经参与或完成工作。'});
 if(name==='galaxy_chat_agent_grant'&&typeof input?.reviewRoom?.title==='string')sections.push({label:'对话',text:input.reviewRoom.title});
 if(preview.workerId)sections.push({label:'执行位置',text:preview.workerName??'所选 Worker'});
 const endpoint=preview.exact?.externalEndpoint??input?.authorizationContext?.endpoint??input?.endpoint;
 if(endpoint)sections.push({label:'服务',text:endpoint});
 if(visibility)sections.push({label:'可见范围',text:nativeAudienceLabel(visibility,recipients)});
 if(recipients?.length)sections.push({label:'接收方',text:recipients.every(v=>typeof v==='string'&&!v.startsWith('GUID'))?recipients.join('、'):`本次选择的 ${recipients.length} 位成员`});
 if(scope)sections.push({label:'AI 可以做什么',text:({read:'读取这段对话',draft:'读取并准备草稿',respond:'在这段对话中回复'}[scope]??scope)});
 if(input?.enabled!==undefined)sections.push({label:'私人同步',text:input.enabled?'开启本次所选笔记的私人同步':'停止后续私人同步'});
 const expires=name==='galaxy_contact_work_execute'?preview.consentExpiresAt:a2aResultAuthorization?.expiresAt??input?.expiresAt??preview.expiresAt??preview.authorizationExpiresAt;
 if(expires){const date=new Date(typeof expires==='number'&&expires<1e12?expires*1000:expires);if(Number.isFinite(date.getTime()))sections.push({label:name==='galaxy_contact_work_execute'?'本次内容授权有效至':'有效至',text:date.toLocaleString('zh-CN')});}
 const identityRefs=[],refs=new Set();
 if(/identity|device/.test(name)){const walk=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){
   if(typeof item==='string'&&(/subjectId|deviceId$/i.test(key))&&(/^(?:GUID[0-9A-Z]{28}|[a-f0-9-]{36})$/.test(item))&&!refs.has(item)){refs.add(item);identityRefs.push({label:/device/i.test(key)?'设备':'身份',value:item});}
   else if(key==='memberIds'&&Array.isArray(item)){for(const id of item)if(typeof id==='string'&&/^GUID[0-9A-Z]{28}$/.test(id)&&!refs.has(id)){refs.add(id);identityRefs.push({label:'成员身份',value:id});}}
   else if(key==='payloadJson'&&typeof item==='string'){try{walk(JSON.parse(item));}catch{/* Exact opaque bytes are in the diagnostic. */}}
   else if(typeof item==='object')walk(item);
  }};walk(input);}
 return {title,rows,sections,identityRefs,recipientRefs:(name==='galaxy_contact_work_execute'?preview.viewers:preview.recipientIds??recipients)?.filter(v=>typeof v==='string'&&v.startsWith('GUID'))??[],
  note:'只允许这里显示的内容与范围。关闭或取消不会批准。'};
}

export function nativeChoiceText(name,input){const choice=describeNativeChoice(name,input);return [choice.title,...choice.rows.map(row=>row.label+'：'+row.text),...choice.sections.map(row=>row.label+'：'+row.text),...choice.identityRefs.map(row=>row.label+'：'+row.value),choice.note].join('\n\n');}

export function presentNativeResult(name,result,{readOnly=false}={}){
 if(result?.resultType==='input_required'||!Array.isArray(result?.content))return result;
 let data=result.structuredContent;
 if(data===undefined&&result.content.length===1&&result.content[0]?.type==='text'){try{data=JSON.parse(result.content[0].text);}catch{return result;}}
 if(data===undefined||data===null)return result;
 // Apps already supply their carefully scoped human presentation and private
 // component metadata. Do not turn it back into a second generic summary.
 if(data.kind==='galaxy-worker-panel'||data.kind==='galaxy-a2a-panel'||data.kind==='galaxy-help-panel'||data.schemaVersion===1&&data.viewId)return result;
 const lines=[],specific=result.isError||data.error?null:communityResultLines(name,data)??bookmarkResultLines(name,data);
 if(result.isError||data.error){const code=data.error??'';
  lines.push(/(?:identity|connection)_required|local_identity_required/.test(code)?'当前设备尚未接入所需身份或服务。可以在原工作按需要接续身份，再继续。':
   /identity|binding|connection/.test(code)?'当前身份或连接已变化，请在原工作重新取得当前允许的内容。':
   /expired|preview_changed|scope_changed/.test(code)?'这次内容或范围已变化，请在原工作重新取得当前预览。':
   /not_authorized|permission|grant/.test(code)?'当前授权已不允许这次操作。可以继续原工作，按实际需要选择范围。':
   '当前内容暂不可用。可以继续原工作，稍后重试取得当前内容。');
  if(data.reconcileOriginal||data.mayNeedReceiptReconciliation)lines.push('请先查询原操作的结果，再决定是否重试。');}
 else if(data.state==='user-choice-needs-browser'){lines.push(nativeChoiceText(data.operation??name,data.preview??{}),'打开本机审阅页完成选择：',data.url);}
 else if(name==='galaxy_command'){lines.push('在原聊天说明想取得的帮助，沿用当前工作继续。可找帮助、发起求助、查看消息或回到原工作。');if(data.state==='recovery-required')lines.push('本机有尚未完成的恢复操作，请先保留当前资料并检查恢复状态。');}
 else if(name==='galaxy_native_status'){lines.push(nativeConnectionMessage(data));}
 else if(name==='galaxy_native_initialize'&&data.initialized){lines.push(data.existingIdentityPreserved?'已沿用已有身份完成这台设备的准备。':'这台设备的稳定身份已准备好。');lines.push('可以继续原工作；连接和外发范围按需要选择。');}
 else if(specific){lines.push(...specific);}
 else{
  if(data.url)lines.push(data.launched?'已请求打开当前内容。':'可以打开当前内容：',data.url);
  const state=nativeStateLabel(data.state??data.status??data.receipt?.state);if(state)lines.push(state+'。');
  for(const row of authoredRows(data,{limit:20,maxText:8000}))lines.push(row.label+'：'+row.text);
  const items=Array.isArray(data)?data:data.items;if(Array.isArray(items)&&!items.length)lines.push('当前没有可显示的内容。');
  if(!lines.length)lines.push(readOnly?'已读取当前允许的信息，可以继续原工作。':'本次操作已返回，可以继续原工作。');
 }
 return {...result,content:[{type:'text',text:lines.filter(Boolean).join('\n\n')}],structuredContent:Array.isArray(data)?{items:data}:data};
}
