import {randomUUID} from 'node:crypto';
import {authoredRows,nativeConnectionMessage} from '../../../packages/galaxy-edge-mcp/src/native-v2/presentation.mjs';
import {chatSendRequestHash} from '../../../packages/galaxy-official/src/shared/chat-message-request-hash.mjs';
import {createNativeCapsuleMenu} from './capsule-native-menu.mjs';
import {createNativeA2aMenu} from './a2a-native-menu.mjs';
import {createNativeTaskMenu} from './task-native-menu.mjs';
import {createProjectDiscoveryMenu} from './project-discovery-menu.mjs';
import {nativeChoiceUrl} from '../../native-v2/compact-app/browser-choice.mjs';
import {nativeConfigurationMessage} from '../../../packages/galaxy-edge-mcp/src/native-v2/configuration.mjs';

 const unwrap=result=>{if(result?.isError)throw new Error(result.structuredContent?.error??'current_content_unavailable');if(result?.structuredContent)return result.structuredContent;try{return JSON.parse(result.content[0].text);}catch{return result;}};
const plain=value=>String(value??'').replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,' ').slice(0,16000);
const fingerprint=status=>JSON.stringify(status.connectionChoice
 ?[status.identity,status.endpoint,status.connectionChoice.revision,status.connectionChoice.enabled,status.connectionChoice.deviceId]
 :[status.identity,status.endpoint,status.connection?.bindingId??null,status.connection?.generation??null]);

// Optional foreground Native bridge, supplied by the host. No service, model,
// identity, account or connection is silently created to populate the menu.
export function createPurposeMenu({nativeTools,controller,select,prompt,info,language='zh-CN',isCurrent,onBack,onReturnWork=onBack,readWorkContext}){
 const zh=language!=='en-US',label=(cn,en)=>zh?cn:en;let version=0,owner=null,navigationId=null,capsuleMenu=null,a2aMenu=null,projectMenu=null,taskMenu=null,messageTimer=null;
 const stopMessages=()=>{clearTimeout(messageTimer);messageTimer=null;};
 const alive=v=>isCurrent()&&(v===undefined||v===version);
 const menu=(title,entries,back=onBack,offset=0)=>{if(!alive())return;stopMessages();const v=++version,routes={};const options=entries.slice(offset,offset+8).map(([title,fn,description=''],i)=>{routes[i+1]=()=>{if(alive(v))fn();};return{number:String(i+1),title,description};});if(offset+8<entries.length){options.push({number:'9',title:label('其他内容','More content'),description:''});routes[9]=()=>menu(title,entries,back,offset+8);}select({title,options,routes,onBack:()=>{if(alive(v))(offset?()=>menu(title,entries,back,Math.max(0,offset-8)):back)();}});};
 const message=(title,text,back=onBack)=>{if(!alive())return;stopMessages();const v=++version;info(title,text,()=>{if(alive(v))back();});};
 async function native(name,args={}){
  const before=unwrap(await nativeTools.call('galaxy_native_status',{}));if(owner!==null&&owner!==fingerprint(before))throw Error('current_identity_changed');owner??=fingerprint(before);
  const data=unwrap(await nativeTools.call(name,args));const after=unwrap(await nativeTools.call('galaxy_native_status',{}));if(owner!==fingerprint(after))throw Error('current_identity_changed');return data;
 }
 async function run(fn,done,back=onBack){stopMessages();const v=++version;info('Galaxy',label('正在取得当前内容…','Reading current content…'),()=>{if(alive(v)){version++;controller?.cancel?.();back();}});
  try{const result=await fn();if(alive(v))await done(result);}catch(error){if(alive(v)){
   if(error.message==='native_connection_choice_required')return identity(()=>void run(fn,done,back),back);
   message('Galaxy',String(error.message).startsWith('native_configuration_')?nativeConfigurationMessage(error,language):label('当前内容暂不可用。可以回到原工作继续，或稍后重试。','Current content is unavailable. Continue the original work or retry later.'),back);
  }}}
 async function openObject(object,back=onBack){return run(async()=>{const context=await readWorkContext?.();return native('galaxy_open',{object,...(context?.origin?{origin:context.origin}:{})});},data=>{navigationId=data.navigationId;message(label('继续打开的内容','Continue in the opened content'),data.launched?label('已请求打开。回来后按 Enter 接续当前工作。','Opening requested. Press Enter on return to resume.'):(data.url??label('当前宿主未提供浏览器入口。','This host has no browser entry.')),()=>void run(()=>native('galaxy_return',{navigationId}),()=>back(),back));},back);}
 function search(){if(nativeTools)return menu(label('找帮助','Find help'),[[label('查找方法与协助','Find methods and help'),searchHelp],[label('寻找同行','Find people and projects'),projects]],onBack);void searchHelp();}
 async function searchHelp(){stopMessages();const v=++version;let context=null;try{context=await readWorkContext?.();}catch{/* A missing host context does not block a new search. */}if(!alive(v))return;
  prompt({title:label('希望得到什么帮助？','What help do you need?'),placeholder:'',value:context?.query?.trim().slice(0,200)??'',onCancel:search,onConfirm:value=>{if(!alive(v))return;const query=value.trim();if(!query||query.length>200)return message('Galaxy',label('请用 200 字以内说明目标。','Describe the goal in up to 200 characters.'),searchHelp);void searchResults(query);}});}
 async function searchResults(query){const requests=nativeTools?['task','capsule','history']:['capsule','case'];
  void run(async()=>{const rows=[],failures=[];let availableScopes=[];
   if(!nativeTools)availableScopes=(await controller.status()).scopes??[];
   for(const type of requests){if(!nativeTools&&!availableScopes.includes(type==='capsule'?'capsules':'history'))continue;
    const input={type,query:{query,limit:4}};try{const page=nativeTools?await native('galaxy_search_v2_query',input):await controller.querySearch(input);for(const item of page.items??[])rows.push({item,input});}catch{failures.push(type);}}
   return {rows,failures};},({rows,failures})=>{
    if(!rows.length)return message(label('找帮助','Find help'),label('当前没有找到可读的匹配内容。可以修改目标，或在原聊天继续准备求助。','No readable matches were found. Change the goal or continue preparing a request in the original chat.'),search);
    const render=()=>menu(label('可以继续查看的帮助','Available help')+(failures.length?'\n'+label('部分来源暂不可用。','Some sources are unavailable.'):'') ,rows.map(({item,input})=>[plain(item.title)||label('当前帮助','Current help'),()=>void run(async()=>{
      // Reread before showing authored details. A cached search row is never
      // treated as continuing permission after its source is withdrawn.
      const page=nativeTools?await native('galaxy_search_v2_query',input):await controller.querySearch(input);return (page.items??[]).find(row=>row.id===item.id);
     },fresh=>{if(!fresh)return message('Galaxy',label('这项内容已变化，请重新查找。','This content changed; search again.'),render);
      if(nativeTools&&fresh.type==='capsule')return methodMenu(render).open(fresh.id,fresh.versionId);
      if(nativeTools&&fresh.type==='task'){
       return openTask(fresh.id,render,query);
      }
      const text=authoredRows(fresh).map(row=>row.label+'：'+plain(row.text)).join('\n\n');
      const currentObject=fresh.type==='task'?{kind:'task',id:fresh.id}:fresh.type==='capsule'?{kind:'capsule',id:fresh.id}:null;
      message(plain(fresh.title),text,()=>menu(label('继续这项帮助','Continue with this help'),[
       ...(nativeTools&&currentObject?[[label('打开完整内容','Open full content'),()=>void openObject(currentObject,render)]]:[]),
       [label('把这项帮助带回原工作','Bring this help to the original work'),()=>void run(async()=>{
        const page=nativeTools?await native('galaxy_search_v2_query',input):await controller.querySearch(input);
        const current=(page.items??[]).find(row=>row.id===fresh.id);if(!current)throw Error('current_content_unavailable');
        return{title:plain(current.title),content:authoredRows(current).map(row=>row.label+'：'+plain(row.text)).join('\n\n')};
       },onReturnWork,render)], [label('查看其他帮助','Other help'),render]],render));
     },render),plain(item.summary)]),search);render();
   },search);
 }
 function openTask(taskId,back,query,methodQuery=null){
  taskMenu?.close();const v=++version;
  taskMenu=createNativeTaskMenu({call:(name,args)=>native(name,args),select,prompt,info,language,isCurrent:()=>alive(v),onBack:back,onReturnWork,readWorkContext,openLink:nativeTools.openLink,searchQuery:query,
   onFindMethods:selection=>websiteIdentity({kind:'task',id:selection.taskId},()=>openTask(taskId,back,query),{
    scopes:['binding','consent','case-teaser','history','assistance','context','capsules'],continueWith:{kind:'method-search',query:selection.query},
    onComplete:()=>openTask(taskId,back,query,selection.query)})});
  return methodQuery===null?taskMenu.open(taskId):taskMenu.bringToWork(taskId,methodQuery);
 }
 function messages(after){if(!nativeTools)return message(label('消息','Messages'),label('这个 OpenCode 连接尚未提供 Native 消息工具。可以在原聊天使用银河消息工具，或打开已配置的完整网页。','This OpenCode connection has no Native message tools. Use the Galaxy message tools in the original chat or the configured full website.'));
  void run(()=>native('galaxy_chat_rooms',{limit:6,...(after?{after}:{})}),page=>{const rooms=page.rooms??[];
   menu(label('消息','Messages'),[...rooms.map(room=>[plain(room.title)||label('对话','Conversation'),()=>roomView(room),label('查看消息并继续这段工作','Read messages and continue this work')]),
    [label('联系与回应','Contacts and responses'),()=>projects(true)],...(page.next?[ [label('较早的对话','Earlier conversations'),()=>messages(page.next)] ]:[])],onBack);});}
 async function readRoom(room){const roomId=room.id??room.roomId;
  const meta=await native('galaxy_chat_room',{roomId}),history=await native('galaxy_chat_history',{roomId,latest:true,limit:40}),grants=await native('galaxy_chat_agent_grants',{roomId,limit:100});
  const status=unwrap(await nativeTools.call('galaxy_native_status',{}));if(owner!==fingerprint(status))throw Error('current_identity_changed');
  const grant=(grants.items??[]).find(g=>g.state==='active'&&g.mode==='respond'&&g.bindingId===status.connection?.bindingId);
  const names=(await native('galaxy_profile_names',{subjectIds:[...new Set((history.messages??[]).map(m=>m.subjectId).filter(Boolean))].slice(0,20)})).items??[];
  return{meta,history,grant,status,names:new Map(names.map(n=>[n.subjectId,n.displayName]))};
 }
 function roomView(room,back=()=>messages()){const roomId=room.id??room.roomId;void run(()=>readRoom(room),initial=>{
  let latest=initial,hasNew=false;
  const readingText=data=>{const members=(data.meta.members??[]).map(member=>member.subjectId);return(data.history.messages??[]).slice(-12).map(m=>(m.subjectId===data.status.identity?label('我','Me'):data.names.get(m.subjectId)||label('成员 ','Member ')+Math.max(1,members.indexOf(m.subjectId)+1))+'：'+plain(m.state==='accepted'?m.text:label('这条消息当前不可读。','This message is currently unavailable.'))).join('\n\n')||label('这段对话还没有可读消息。','No readable messages yet.');};
  const actions=()=>menu(plain(latest.meta.title??room.title),[
   ...(hasNew?[[label('新消息','New messages'),()=>roomView(room,back),label('已自动取得当前允许的消息，继续阅读。','Current authorized messages were read automatically; continue reading.')]]:[]),
   ...(latest.meta.transportAvailable===true&&!['archived','owner-succession'].includes(latest.meta.state)?[ [label('写消息','Write a message'),()=>reply(room,latest.grant,back)] ]:[]),
   [label('打开完整对话','Open full conversation'),()=>void openObject({kind:'room',id:roomId},()=>roomView(room,back))],
   [label('把对话带回原工作','Bring the conversation to the original work'),()=>void run(()=>readRoom(room),fresh=>onReturnWork({title:plain(fresh.meta.title??room.title),content:readingText(fresh),
    ...(fresh.status.website?{sourceUrl:new URL('/app/rooms/'+roomId,fresh.status.website).href}:{})}),()=>roomView(room,back))]],back);
  const finishReading=()=>{hasNew=false;actions();};
  message(plain(initial.meta.title??room.title),readingText(initial),finishReading);
  const v=version,signature=d=>JSON.stringify([d.meta.title,d.meta.state,d.meta.transportAvailable,d.grant,d.history.messages,[...d.names]]);
  const watch=()=>{messageTimer=setTimeout(async()=>{if(!alive(v))return;try{const fresh=await readRoom(room);if(!alive(v))return;
    if(signature(fresh)!==signature(latest)){const changedText=readingText(fresh)!==readingText(latest)||fresh.meta.title!==latest.meta.title;
     hasNew ||=JSON.stringify(fresh.history.messages)!==JSON.stringify(latest.history.messages);latest=fresh;
     // Stable DialogAlert accepts immutable text. Replace only the still-open
     // reading alert when its readable content changes, keeping the same Enter
     // continuation. Any editor or selected action invalidates this version.
     if(changedText)info(plain(fresh.meta.title??room.title),readingText(fresh),()=>{if(alive(v))finishReading();});
    }
    watch();
   }catch{if(alive(v))message(label('暂时无法读取这段对话','Unable to read this conversation'),label('暂时无法取得当前允许的消息。可以保留原工作，稍后重新打开。','Current authorized messages could not be read. Retain your original work and reopen the conversation later.'),back);}},5000);messageTimer.unref?.();};watch();
 },back);}
 function reply(room,grant,back=()=>messages(),draft=''){stopMessages();const v=++version;prompt({title:label('写给这段对话的消息','Write to this conversation'),placeholder:'',value:draft,onCancel:()=>roomView(room,back),onConfirm:text=>{if(!alive(v))return;if(!text.trim())return roomView(room,back);
  if(!grant)return allowReply(room,text.trim(),back);
  const roomId=room.id??room.roomId,payload={clientMessageId:randomUUID(),text:text.trim(),replyTo:null,agentGrantId:grant.grantId};
  const send=()=>void run(async()=>{try{return await native('galaxy_chat_send',{roomId,...payload});}catch{const receipt=await native('galaxy_chat_message_status',{roomId,clientMessageId:payload.clientMessageId,requestHash:await chatSendRequestHash(payload)});return{...receipt,state:receipt.state==='not-found'?'absent':receipt.state};}},result=>{
   if(result.state==='accepted'||result.messageId&&!result.state)return roomView(room,back);
   // A confirmed absent receipt can offer the same original bytes. Unknown or
   // conflict never creates a second message or silently changes its grant.
   menu(label('发送结果尚待确认','Sending needs confirmation'),[[label('继续这条消息','Continue this message'),()=>void run(async()=>native('galaxy_chat_message_status',{roomId,clientMessageId:payload.clientMessageId,requestHash:await chatSendRequestHash(payload)}),r=>r.state==='accepted'?roomView(room,back):message('Galaxy',label('原消息尚未确认，可以在完整对话中继续。','The original message is not confirmed. Continue in the full conversation.'),()=>roomView(room,back)))],...(result.state==='absent'?[[label('重试同一条消息','Retry the same message'),send]]:[]),[label('回到原工作','Return to original work'),onReturnWork]],()=>roomView(room,back));
  },()=>reply(room,grant,back,text));send();}});}
 function allowReply(room,text,back){stopMessages();const v=++version,roomId=room.id??room.roomId,input={roomId,grantId:randomUUID(),mode:'respond',primaryResponder:false,expiresAt:Math.floor(Date.now()/1000)+3600};let busy=false,opened=null;
  const tick=async()=>{if(!alive(v)||busy)return;busy=true;try{const value=await native('galaxy_chat_agent_grant',input);if(!alive(v))return;
   if(value.state==='declined')return reply(room,null,back,text);
   if(value.state==='user-choice-needs-browser'){const url=nativeChoiceUrl(value.url);if(!url)throw Error('local_choice_unavailable');if(opened!==url){opened=url;await nativeTools.openLink?.(url);if(!alive(v))return;
    info(label('允许这段对话回复','Allow replies in this conversation'),label('当前宿主尚无回复权限。请在本机选择页核对：只在这段对话读取与回复，有效一小时；不会开启模型或后台运行。原消息仍保留，允许后发送。','This host has no reply permission. Review reading and responding only in this room for one hour on the local choice page. This starts no model or background loop. Your message is retained and sends after approval.'),()=>{if(alive(v))void tick();});}
    messageTimer=setTimeout(()=>void tick(),1500);messageTimer.unref?.();return;}
   const fresh=await readRoom(room);if(!alive(v))return;if(!fresh.grant)throw Error('reply_grant_unavailable');
   // The written message already expressed this send. Use that exact text
   // after the actual permission choice, without asking to compose it again.
   const payload={roomId,clientMessageId:randomUUID(),text,replyTo:null,agentGrantId:fresh.grant.grantId};
   let sent;try{sent=await native('galaxy_chat_send',payload);}catch{sent=await native('galaxy_chat_message_status',{roomId,clientMessageId:payload.clientMessageId,requestHash:await chatSendRequestHash(payload)});}
   if(alive(v)){if(sent.state==='accepted'||sent.messageId&&!sent.state)roomView(room,back);else message(label('消息尚待确认','Message needs confirmation'),label('原消息尚未确认，已保留这次定位。可以继续原对话。','The original message is not confirmed. Continue this conversation.'),()=>roomView(room,back));}
  }catch{if(alive(v))message(label('消息未能继续','Unable to continue message'),label('当前权限或服务不可用。原文字保留，请稍后再试。','The permission or service is unavailable. Your text is retained; retry later.'),()=>reply(room,null,back,text));}finally{busy=false;}};
  info(label('正在准备回复','Preparing reply'),label('核对这段对话的实际权限。','Checking this conversation’s permission.'),()=>{if(alive(v))void tick();});void tick();}
 function projects(showContacts=false){if(!nativeTools)return onBack();stopMessages();projectMenu?.close();const v=++version;projectMenu=createProjectDiscoveryMenu({nativeCall:(name,args)=>native(name,args),select,prompt,info,language,
  isCurrent:()=>alive(v),onBack, onReturnWork,readWorkContext,openLink:nativeTools.openLink,onOpenRoom:room=>{projectMenu?.close();roomView(room,()=>projects(true));}});if(showContacts)projectMenu.contacts();else projectMenu.open();}
 function publish(){if(nativeTools)return websiteIdentity({kind:'publish'});message(label('发起求助','Ask for help'),label('回到原聊天说明目标和需要的帮助，AI 会沿用当前内容准备求助。新的外发内容与范围仍会单独显示供你选择。','Describe the goal and help needed in the original chat. AI can prepare the request from current content; new external content and scope remain your choice.'));}
 function identity(onReady=null,back=onBack){if(!nativeTools)return onBack();void run(()=>native('galaxy_native_status'),status=>{
  if(onReady&&status.connected===true)return onReady();
  const body=[nativeConnectionMessage(status,language),
   ...(status.identity?[label('当前银河身份：','Current Galaxy identity: ')+plain(status.identity)]:[label('这台设备尚未准备银河身份。可以在本机准备；连接服务会另行显示实际范围。','This device has no prepared Galaxy identity. Prepare it locally; connecting to a service shows its actual scope separately.')]),
   ...(status.endpoint?[label('当前服务：','Current service: ')+plain(status.endpoint)]:[])];
  menu(label('身份与设备','Identity and devices')+' · '+(status.connected===true?label('已连接','Connected'):status.connectionError?label('连接暂不可用','Connection unavailable'):status.identity?label('尚未连接','Disconnected'):label('尚未准备','Not prepared')),[
   ...(!status.identity?[[label('在本机准备身份','Prepare this device'),()=>identityChoice('galaxy_native_initialize',{profile:'minimal'},()=>identity(onReady,back))]]:[]),
   ...(status.identity&&status.connected!==true?[status.connectionChoice?.enabled===true?
    [label('重试当前连接','Retry current connection'),()=>identity(onReady,back)]:
    [label('连接当前身份','Connect this identity'),()=>identityChoice('galaxy_native_connect',{},()=>identity(onReady,back))]]:[]),
   ...(status.connected===true?[[label('在官网继续当前身份','Continue this identity on the website'),()=>websiteIdentity({kind:'publish'},()=>identity(null,back))]]:[]),
   ...(status.connected===true?[[label('打开当前身份与设备','Open current identity and devices'),()=>void openObject({kind:'identity'},identity)]]:[]),
   ...(status.connected===true?[[label('断开本机连接','Disconnect this local connection'),()=>identityChoice('galaxy_native_disconnect',{})]]:[]),
   [label('当前身份与服务','Current identity and service'),()=>message(label('当前身份与服务','Current identity and service'),body.join('\n\n'),()=>identity(onReady,back))],
   [label('回到原工作','Return to original work'),onReturnWork]],back);
 },back);}
 function identityChoice(name,input,done=identity){
  stopMessages();const v=++version;let busy=false,choiceUrl=null,initial=null;
  const title=name==='galaxy_native_initialize'?label('在本机准备身份','Prepare this device'):name==='galaxy_native_disconnect'?label('断开本机连接','Disconnect this local connection'):label('连接当前身份','Connect this identity');
  const tick=async()=>{
   if(!alive(v)||busy)return;busy=true;
   try{
    const before=unwrap(await nativeTools.call('galaxy_native_status',{}));if(!alive(v))return;
    const beforeKey=fingerprint(before);if(initial===null){initial=beforeKey;if(owner!==null&&owner!==beforeKey)throw Error('current_identity_changed');}
    else if(beforeKey!==initial)throw Error('current_identity_changed');
    // Only this explicitly selected identity transition may change the menu's
    // owner/binding. The Native server checks its original real choice before
    // executing; generic reads and writes retain the ordinary owner fence.
    const value=unwrap(await nativeTools.call(name,input));if(!alive(v))return;
    if(value.state==='user-choice-needs-browser'){
     const url=nativeChoiceUrl(value.url);if(!url)throw Error('local_choice_unavailable');
     if(choiceUrl!==url){choiceUrl=url;await nativeTools.openLink?.(url);if(!alive(v))return;
      info(title,label('请在本机选择页核对这次内容与范围。允许后会自动继续；原工作仍保留。','Review this operation and scope in the local choice page. It continues after approval; the original work is retained.')+'\n\n'+url,()=>{if(alive(v))void tick();});}
     messageTimer=setTimeout(()=>void tick(),1500);messageTimer.unref?.();return;
    }
    if(value.state==='declined')return message(title,label('这次操作未获准。可以继续原工作，或重新选择。','This operation was not approved. Continue the original work or choose again.'),identity);
    const after=unwrap(await nativeTools.call('galaxy_native_status',{}));if(!alive(v))return;
    if(name==='galaxy_native_initialize'&&(!after.identity||value.identity!==after.identity)||name==='galaxy_native_connect'&&after.connected!==true||name==='galaxy_native_disconnect'&&after.connected===true)throw Error('native_identity_transition_unconfirmed');
    owner=fingerprint(after);done();
   }catch(error){if(alive(v))message(title,String(error.message).startsWith('native_configuration_')?nativeConfigurationMessage(error,language):label('这次操作暂未完成。原身份与工作仍保留，请检查当前连接后再试。','This operation has not completed. Existing identity and work are retained; check this connection before retrying.'),identity);}
   finally{busy=false;}
  };
  info(title,label('正在准备本次操作…','Preparing this operation…'),()=>{if(alive(v))void tick();});void tick();
 }
 function websiteIdentity(object,back=onBack,options={}){
  const requestId=randomUUID();
  void run(async()=>{const context=await readWorkContext?.();return native('galaxy_identity_web_connect',{requestId,object,...(context?.origin?{origin:context.origin}:{}),...(options.scopes?{scopes:options.scopes}:{}),...(options.continueWith?{continueWith:options.continueWith}:{})});},first=>{
   navigationId=first.navigationId;const v=++version;let busy=false;
   const show=value=>{
    if(!alive(v))return;
    if(value.state==='completed'&&value.deviceAuthorizationVerified===true)return message(label('在官网继续','Continue on the website'),label('本次设备授权已完成。可以在已打开的网页继续，或回到原工作。','This device authorization completed. Continue on the opened website or return to the original work.'),options.onComplete??onReturnWork);
    if(['canceled','expired','transport-unavailable'].includes(value.state)||value.transportAvailable!==true)return message(label('网页接续尚未完成','Website connection is incomplete'),label('这次接续已结束或暂时不可用，原身份和操作记录仍保留。可以继续原工作。','This connection ended or is unavailable. The original identity and operation record are retained; continue your work.'),back);
    const url=new URL(value.url);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/connect/'+value.handoffId||url.username||url.password||url.search||url.hash)throw Error('web_identity_local_url_invalid');
    info(label('在官网继续当前身份','Continue this identity on the website'),label('在本机接续页打开官网，并核对同一身份、这个网页设备和实际范围。只有你的明确选择会授权；原工作仍保留。','Open the website from the local connection page and review this identity, web device and exact scope. Your explicit choice grants access; the original work is retained.')+'\n\n'+url.href,()=>{if(alive(v))void tick();});
   };
   const tick=async()=>{if(!alive(v)||busy)return;busy=true;try{
    const value=await native('galaxy_identity_web_connect_status',{handoffId:first.handoffId});if(!alive(v))return;
    if(value.state==='completed'||['canceled','expired','transport-unavailable'].includes(value.state)||value.transportAvailable!==true){stopMessages();show(value);return;}
    messageTimer=setTimeout(()=>void tick(),1500);messageTimer.unref?.();
   }catch{if(alive(v))message(label('网页接续尚待确认','Website connection needs confirmation'),label('暂时无法读取这次进度。原身份与接续记录仍保留，未创建另一身份。可以回到原工作。','The progress cannot currently be read. The original identity and connection record are retained; no other identity was created. Return to the original work.'),onReturnWork);}finally{busy=false;}};
   try{show(first);if(alive(v))void tick();}catch{message('Galaxy',label('本机接续地址当前不可用。原身份仍保留。','The local connection address is unavailable. The original identity is retained.'),back);}
  },back);
 }
 function methodMenu(back=onBack){capsuleMenu?.close();const v=++version;
  capsuleMenu=createNativeCapsuleMenu({call:(name,args)=>native(name,args),select,prompt,info,language,
   isCurrent:()=>alive(v),onBack:back,onReturnWork,readWorkContext,openLink:nativeTools?.openLink});return capsuleMenu;}
 function methods(){if(!nativeTools)return message(label('方法','Methods'),label('这个入口尚未提供 Native 方法工具。请从原工作使用已配置的银河工具。','This entry has no Native method tools. Use the configured Galaxy tools from the original work.'));methodMenu().home();}
 function external(){if(!nativeTools)return onBack();stopMessages();a2aMenu?.close();const v=++version;a2aMenu=createNativeA2aMenu({call:(name,args)=>native(name,args),select,prompt,info,language,isCurrent:()=>alive(v),onBack,onReturnWork,onOpenLink:nativeTools.openLink,readWorkContext});a2aMenu.home();}
 return Object.freeze({search,messages,publish,identity,methods,external,projects,openObject,close(){version++;stopMessages();owner=null;navigationId=null;capsuleMenu?.close();a2aMenu?.close();projectMenu?.close();taskMenu?.close();}});
}
