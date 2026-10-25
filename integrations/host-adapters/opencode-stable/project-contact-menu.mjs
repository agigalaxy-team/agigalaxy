import {discoveryQueryV2Schema} from '../../../packages/galaxy-official/src/shared/discovery-schema-v2.mjs';
import {authoredRows} from '../../../packages/galaxy-edge-mcp/src/native-v2/interaction/presentation.mjs';
import {nativeChoiceUrl} from '../../native-v2/compact-app/browser-choice.mjs';

const plain=value=>String(value??'').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,24000);
const brief=value=>Array.from(plain(value)).slice(0,65).join('');
const unwrap=value=>{const data=value?.structuredContent??value;if(value?.isError)throw Object.assign(Error(data.error??'current_content_unavailable'),{code:data.error});if(data===value&&value?.content?.[0]?.text){try{return JSON.parse(value.content[0].text);}catch{/* Already readable data. */}}return data;};
const tags=value=>[...new Set(String(value).split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean))];

// Foreground Dialog navigation over existing Discovery, Contact and Chat. The
// original work belongs to the host; no prompt text is copied into a Contact.
export function createNativeProjectDiscoveryMenu({call,select,prompt,info,language='zh-CN',isCurrent,onBack,onReturnWork=onBack,onOpenRoom,openLink,readWorkContext,now=()=>Math.floor(Date.now()/1000)}){
 const zh=language!=='en-US',label=(cn,en)=>zh?cn:en;
 const purposes={conversation:label('交流想法','Discuss ideas'),reuse:label('了解复用','Discuss reuse'),collaboration:label('一起做事','Collaborate'),recruitment:label('了解招募','Discuss recruitment')};
 const states={sent:label('等待回应','Awaiting response'),accepted:label('可以继续聊天','Continue chatting'),declined:label('已谢绝','Declined'),withdrawn:label('已撤回','Withdrawn'),expired:label('已到期','Expired')};
 let generation=0,timer=null,closed=false,context={title:'',functions:'',technologies:'',purposes:['conversation','collaboration']},query=null,owner=null;
 const drafts=new Map();
 const alive=v=>!closed&&isCurrent()&&(v===undefined||v===generation);
 const stop=()=>{clearTimeout(timer);timer=null;};
 const begin=()=>{stop();return++generation;};
 const gate=(v,work)=>(...args)=>{if(alive(v))return work(...args);};
 async function native(name,args={}){const value=unwrap(await call(name,args));if(value?.error)throw Object.assign(Error(value.error),{code:value.error});return value;}
 function menu(title,entries,back=home,offset=0){if(!alive())return;const v=begin(),routes={},options=entries.slice(offset,offset+7).map(([title,work,description=''],i)=>{
  routes[String(i+1)]=gate(v,work);return{number:String(i+1),title:brief(title),description:brief(description)};});
  if(offset+7<entries.length){options.push({number:'8',title:label('更多内容','More content')});routes[8]=gate(v,()=>menu(title,entries,back,offset+7));}
  select({title,options,routes,onBack:gate(v,offset?()=>menu(title,entries,back,Math.max(0,offset-7)):back)});return v;
 }
 function notice(title,text,back=home){if(!alive())return;const v=begin();info(plain(title),plain(text),gate(v,back));return v;}
 function ask(title,value,done,back){if(!alive())return;const v=begin();prompt({title,value:plain(value),placeholder:'',onConfirm:gate(v,done),onCancel:gate(v,back)});}
 async function run(work,done,back=home){if(!alive())return;const v=begin();info(label('正在读取','Reading'),label('正在取得当前允许的内容。','Reading currently authorized content.'),gate(v,back));
  try{const data=await work();if(alive(v))done(data);}catch(error){if(alive(v))failure(error,back);}}
 function failure(error,back){const stale=/source|opportunity|willingness|revision/.test(error.code??error.message),changed=/identity|binding|connection/.test(error.code??error.message);
  notice(label('暂时无法继续','Unable to continue'),changed?label('当前身份或连接已变化。原联系保留，请从当前身份重新打开。','The identity or connection changed. The original contact is retained; reopen it with the current identity.')
   :stale?label('这份介绍或交流意愿已变化。可以返回重新查找；已写内容仍保留。','The introduction or contact wish changed. Search again; your text is retained.')
   :label('当前内容暂时无法读取。可以返回原工作，稍后再试。','This content is unavailable. Continue the original work and retry later.'),back);}
 async function identity(){const status=await native('galaxy_native_status');const tag=JSON.stringify([status.identity,status.endpoint,status.connection?.bindingId,status.connection?.generation]);
  if(owner!==null&&owner!==tag)throw Object.assign(Error('current_identity_changed'),{code:'current_identity_changed'});owner??=tag;return status;}
 async function home(){await run(async()=>{await identity();return native('galaxy_contact_work_pending');},pending=>menu(label('寻找同行','Find people and projects'),[
  [label('按方向查找','Find by direction'),direction],
  [label('从自己的项目查找','Find from my project'),()=>projects()],
  [label('联系与回应','Contacts and responses'),()=>contacts()],
  ...((pending.items??[]).length?[[label('继续尚未完成的联系','Continue an unfinished contact'),()=>pendingContacts(pending.items)]]:[]),
  [label('回到原工作','Return to original work'),onReturnWork]],onBack));}
 async function direction(){if(!context.title)await run(async()=>{const current=await readWorkContext?.();if(!current?.caseId)return null;try{return await native('galaxy_case_v2_read',{caseId:current.caseId,...(current.taskId?{taskId:current.taskId}:{})});}catch{return null;}},work=>{
   context.title=(work?.events?.find(e=>e.kind==='case-created')?.title??'').slice(0,80);editDirection();});else editDirection();}
 function editDirection(){ask(label('想找什么方向','What direction interests you?'),context.title,value=>{context.title=value.trim();const result=discoveryQueryV2Schema.safeParse({context:{kind:'ephemeral',title:context.title,functions:tags(context.functions||context.title),technologies:tags(context.technologies)},purposes:context.purposes});
  if(!result.success)return notice(label('修改查找方向','Edit direction'),label('用简短的方向词说明想交流的内容；多个方向可以各写一行。','Describe the topic with a few short direction words, one per line if needed.'),editDirection);
  query={context:result.data.context,purposes:result.data.purposes};void find();},home);}
 function filters(){menu(label('交流方式与筛选','Contact purpose and filters'),[
  [label('交流方式','Contact purposes'),()=>editPurposes(context.purposes,value=>{context.purposes=value;filters();},filters),context.purposes.map(v=>purposes[v]).join(' · ')],
  [label('限定方向（可选）','Direction filter (optional)'),()=>ask(label('限定哪些方向','Limit to which directions?'),context.functions,value=>{context.functions=value.trim();filters();},filters),context.functions],
  [label('技术或环境（可选）','Technology or environment (optional)'),()=>ask(label('技术或环境','Technology or environment'),context.technologies,value=>{context.technologies=value.trim();filters();},filters),context.technologies],
  [label('开始查找','Find'),editDirection]],editDirection);}
 function editPurposes(selected,done,back){const draft=[...selected],render=()=>menu(label('希望怎样交流','How would you like to connect?'),[
  ...Object.entries(purposes).map(([id,title])=>[(draft.includes(id)?'✓ ':'○ ')+title,()=>{const i=draft.indexOf(id);if(i<0)draft.push(id);else draft.splice(i,1);render();}]),
  [label('使用这些选择','Use these choices'),()=>draft.length?done(draft):notice(label('交流方式','Contact purposes'),label('请至少选择一种交流方式。','Choose at least one purpose.'),render)]],back);render();}
 function projects(after){void run(()=>native('galaxy_project_v2_query',{limit:7,...(after?{after}:{})}),page=>{
  const items=page.items??page.projects??[];menu(items.length?label('选择自己的项目','Choose my project'):label('暂无可读项目','No readable projects'),[
   ...items.map(p=>[p.document?.title??p.title??label('项目','Project'),()=>{query={context:{kind:'project',projectId:p.projectId},purposes:context.purposes};void find();},p.document?.summary??p.summary]),
   ...(page.nextAfter?[[label('更多项目','More projects'),()=>projects(page.nextAfter)]]:[]),
   [label('按方向查找','Find by direction'),direction]],home);});}
 async function find(after=null){if(!query)return editDirection();await run(()=>native('galaxy_discovery_v2_query',{...query,after,limit:6}),page=>{
  if(!page.enabled)return notice(label('交流设置','Contact settings'),label('当前交流意愿已关闭或暂停。可以在现有交流设置中调整，再继续查找。','Discovery is explicitly off or paused. Change the current contact setting before searching again.'),home);
  const entries=(page.items??[]).map(item=>[item.project.title,()=>readOpportunity(item,()=>find(after)),[item.displayName,item.help?.statement??item.project.summary].filter(Boolean).join(' · ')]);
  if(page.nextAfter)entries.push([label('更多结果','More results'),()=>find(page.nextAfter)]);
  entries.push([label('修改方向与筛选','Edit direction or filters'),filters],[label('联系与回应','Contacts and responses'),()=>contacts()]);
  menu(page.items?.length?label('相关的人和项目','Related people and projects'):label('暂时没有找到相关项目','No related projects found'),entries,home);
 });}
 async function detail(item,after=null){return native('galaxy_discovery_v2_detail',{...query,opportunityRef:item.opportunityRef,experienceAfter:after,experienceLimit:6});}
 function opportunityBody(data){const item=data.opportunity,p=item.project,body=[item.displayName??label('对方尚未提供可显示名称','No display name is available'),p.summary];
  if(item.help?.statement&&item.help.statement!==p.summary)body.push(item.help.statement);
  if(p.functions?.length)body.push(label('方向','Directions')+'\n'+p.functions.join(' · '));
  if(p.technologies?.length)body.push(label('技术或环境','Technology or environment')+'\n'+p.technologies.join(' · '));
  const experience=data.experience?.items??[];body.push(label('当前可读的工作经历','Currently readable experience')+'\n'+(experience.length?experience.map(e=>e.title??label('这项工作','This work')).join('\n'):label('对方暂未分享可读的工作经历。','No readable experience has been shared.')));
  return body.join('\n\n');}
 function readOpportunity(item,back=()=>find()){void run(()=>detail(item),data=>{
  const actions=()=>opportunityActions(data,back);notice(data.opportunity.project.title,opportunityBody(data),actions);
 },back);}
 function opportunityActions(data,back){const item=data.opportunity;menu(item.project.title,[
  [label('写联系内容','Write a contact message'),()=>compose(item,()=>opportunityActions(data,back))],
  [label('阅读工作经历','Read experience'),()=>experiences(item,null,()=>opportunityActions(data,back))],
  [label('再读项目介绍','Read introduction again'),()=>readOpportunity(item,back)],
  [label('来源与适用差异','Sources and differences'),()=>notice(label('来源与适用差异','Sources and differences'),JSON.stringify({opportunityRef:item.opportunityRef,classification:item.classification,participant:item.participant,match:item.match,sources:item.sources},null,2),()=>readOpportunity(item,back))],
  [label('回到原工作','Return to original work'),onReturnWork]],back);}
 function experiences(item,after,back){void run(()=>detail(item,after),data=>{const page=data.experience,items=page.items??[];
  if(!items.length)return notice(label('当前可读经历','Currently readable experience'),label('这次未读到对方分享的工作经历。','No shared work experience was readable in this query.'),back);
  const render=()=>menu(label('工作经历','Work experience'),[...items.map(e=>[e.title??label('这项工作','This work'),()=>readExperience(item,e,after,render),e.summary]),
   [label('经历来源详情','Experience source details'),()=>void run(()=>detail(item,after),fresh=>notice(label('经历来源详情','Experience source details'),JSON.stringify(fresh.experience,null,2),render),render)],
   ...((page.nextCursor??page.nextAfter)?[[label('更多经历','More experience'),()=>experiences(item,page.nextCursor??page.nextAfter,back)]]:[])],back);render();},back);}
 function readExperience(item,entry,after,back){void run(()=>detail(item,after),data=>{const fresh=data.experience.items.find(e=>e.key===entry.key);if(!fresh)return notice(label('这项经历暂不可读','This experience is unavailable'),label('原来源或可见范围已变化。','The source or current access changed.'),back);
  const outcome=value=>({succeeded:label('完成','Completed'),partial:label('部分完成','Partial'),failed:label('未完成','Failed'),inconclusive:label('暂不能得出结论','Inconclusive'),conflicting:label('观察有冲突','Conflicting')}[value]);
  let text;if(fresh.kind==='case-history'){
   const lines=[fresh.summary];if(fresh.reportedOutcome==='unrecorded')lines.push(label('这项工作尚未单独记录整体结论。','An overall conclusion has not been recorded for this work.'));
   else if(outcome(fresh.reportedOutcome))lines.push(label('整项工作的记录','Overall recorded conclusion')+'\n'+outcome(fresh.reportedOutcome));
   for(const attempt of fresh.attempts??[])lines.push(label('已有尝试','Existing approach')+'\n'+plain(attempt.strategy??attempt.approach??attempt.summary??''));
   for(const result of fresh.results??[])lines.push(label('这次结果','This result')+'\n'+[outcome(result.reportedOutcome??result.outcome),result.summary,...(Array.isArray(result.limitations)?result.limitations:[result.limitations])].filter(Boolean).map(plain).join('\n'));
   for(const intervention of fresh.interventions??[])lines.push(label('实际协助','Actual help')+'\n'+authoredRows(intervention).filter(row=>!row.download).map(row=>row.label+'：'+row.text).join('\n'));
   for(const resolution of fresh.resolutions??[])lines.push(label('单独记录的完成结论','Separately recorded conclusion')+'\n'+authoredRows(resolution).filter(row=>!row.download).map(row=>row.label+'：'+row.text).join('\n'));
   text=lines.filter(Boolean).join('\n\n');
  }else text=authoredRows(fresh,{limit:70,maxText:22000}).filter(row=>!row.download).map(row=>row.label+'\n'+row.text).join('\n\n');
  notice(fresh.title??label('工作经历','Work experience'),text||fresh.summary||label('当前来源未提供正文。','This source has no readable body.'),back);
 },back);}
 function compose(item,back){const key=JSON.stringify(item.opportunityRef),draft=drafts.get(key)??{note:'',purpose:item.match.purposes.includes('conversation')?'conversation':item.match.purposes[0]};drafts.set(key,draft);
  const write=()=>ask(label('给这位同行写联系内容','Write to this person'),draft.note,value=>{draft.note=value.trim();if(!draft.note||draft.note.length>2000)return notice(label('联系内容','Contact message'),label('请写 2000 字以内的联系内容。','Write a message of up to 2000 characters.'),write);
   void run(()=>native('galaxy_contact_work_prepare',{action:'send',context:query.context,opportunityRef:item.opportunityRef,purpose:draft.purpose,note:draft.note,roomTitle:item.project.title}),p=>execute(p,back),back);
  },back);
  if(item.match.purposes.length===1||draft.purpose==='conversation')return write();
  menu(label('这次联系想做什么','What is this contact for?'),item.match.purposes.map(id=>[purposes[id],()=>{draft.purpose=id;write();}]),back);
 }
 function pendingContacts(items){menu(label('尚待接续的联系','Unfinished contacts'),items.map(p=>[p.title,()=>execute(p,home)]),home);}
 function execute(prepared,back){if(!alive())return;const v=begin();let inFlight=false,choice=null;
  const tick=async()=>{if(!alive(v)||inFlight)return;inFlight=true;try{
   const checked=await native('galaxy_contact_work_status',{handle:prepared.handle});if(!alive(v))return;
   if(checked.state==='acknowledged')return contactView(checked.receipt.contactId,back);
   const result=await native(checked.state==='prepared'?'galaxy_contact_work_execute':'galaxy_contact_work_resume',{handle:prepared.handle});if(!alive(v))return;
   if(result.state==='acknowledged')return contactView(result.receipt.contactId,back);
   if(result.state==='canceled'||result.state==='declined')return notice(label('本次操作已取消','This operation was canceled'),label('已取消这次选择，内容仍保留。','This choice was canceled; your text is retained.'),back);
   if(result.state==='user-choice-needs-browser'){
    const url=nativeChoiceUrl(result.url);if(!url)throw Error('local_choice_unavailable');if(choice!==url){choice=url;await openLink?.(url);if(!alive(v))return;
     info(label('等待你的选择','Waiting for your choice'),label('在本机选择页核对这次联系内容与接收方。允许后自动继续；返回原工作不会批准。','Review this contact and its recipient on the local choice page. Approval continues automatically; returning does not approve.'),gate(v,()=>void tick()));}
    timer=setTimeout(()=>void tick(),1500);timer.unref?.();return;
   }
   menu(label('这次联系尚待接续','This contact needs to continue'),[[label('继续原联系','Continue this contact'),()=>execute(prepared,back)],[label('回到原工作','Return to original work'),onReturnWork]],back);
  }catch(error){if(alive(v))failure(error,back);}finally{inFlight=false;}};
  info(label('正在处理这次联系','Continuing this contact'),label('正在核对原操作并接续。','Checking and continuing the original operation.'),gate(v,()=>void tick()));void tick();}
 function contacts(direction='both',after){void run(async()=>{const page=await native('galaxy_contacts_v2_query',{direction,limit:6,...(after?{after}:{})});const status=await identity();
  const ids=[...new Set(page.items.flatMap(c=>[c.initiatorId,c.recipientId]).filter(id=>id!==status.identity))];const names=(await native('galaxy_profile_names',{subjectIds:ids})).items??[];return{page,status,names:new Map(names.map(n=>[n.subjectId,n.displayName]))};},({page,status,names})=>{
   menu(label('联系与回应','Contacts and responses'),[...page.items.map(c=>{const person=names.get(c.initiatorId===status.identity?c.recipientId:c.initiatorId),note=c.events.find(e=>e.kind==='send')?.roomTitle;
    return[note??person??label('这次联系','This contact'),()=>contactView(c.contactId,()=>contacts(direction,after)),[c.initiatorId===status.identity?label('我发起的','Sent by me'):label('对方发来的','Received'),states[c.state],person].filter(Boolean).join(' · ')];}),
    ...(page.nextAfter?[[label('更多联系','More contacts'),()=>contacts(direction,page.nextAfter)]]:[]),[label('收到的联系','Received contacts'),()=>contacts('incoming')],[label('我发起的联系','Sent contacts'),()=>contacts('outgoing')],
    [label('回到原工作','Return to original work'),onReturnWork]],home);});}
 function contactView(contactId,back=()=>contacts()){void run(async()=>{const contact=await native('galaxy_contact_v2_get',{contactId}),status=await identity();return{contact,status};},({contact,status})=>{
  if(contact.state==='accepted'&&contact.roomId&&onOpenRoom)return onOpenRoom({roomId:contact.roomId,title:contact.events.find(e=>e.kind==='send')?.roomTitle??label('交流','Conversation')},back);
  const sent=contact.events.find(e=>e.kind==='send'),text=[states[contact.state],...(contact.events??[]).map(e=>e.contentUnavailable?label('这次内容当前不可读。','This content is no longer readable.'):(e.kind==='send'?label('联系内容','Contact message'):e.kind==='accept'?label('对方回应','Response'):states[e.kind]??label('回应','Response'))+'\n'+plain(e.note))].filter(Boolean).join('\n\n');
  const respond=action=>void run(()=>native('galaxy_contact_work_prepare',{action,contactId,note:''}),p=>execute(p,back),()=>contactView(contactId,back));
  const actions=()=>{const v=menu(sent?.roomTitle??label('这次联系','This contact'),[
   ...(contact.state==='sent'&&contact.recipientId===status.identity?[[label('接受并继续聊天','Accept and continue chatting'),()=>respond('accept')],[label('谢绝这次交流','Decline this contact'),()=>respond('decline')]]:[]),
   ...(contact.state==='sent'&&contact.initiatorId===status.identity?[[label('撤回这次联系','Withdraw this contact'),()=>respond('withdraw')]]:[]),
   [label('再读联系内容','Read contact again'),()=>contactView(contactId,back)],
   [label('来源详情','Source details'),()=>notice(label('联系来源','Contact source'),JSON.stringify(contact,null,2),()=>contactView(contactId,back))],
   [label('回到原工作','Return to original work'),onReturnWork]],back);watch(v);};
  const watch=v=>{if(contact.state!=='sent')return;timer=setTimeout(async()=>{if(!alive(v))return;try{const fresh=await native('galaxy_contact_v2_get',{contactId});if(!alive(v))return;if(fresh.state!==contact.state||fresh.revision!==contact.revision)return contactView(contactId,back);watch(v);}catch(error){if(alive(v))failure(error,back);}},4000);timer.unref?.();};
  const v=notice(sent?.roomTitle??label('这次联系','This contact'),text,actions);watch(v);
 },back);}
 return{open:home,contacts,close(){closed=true;begin();}};
}
