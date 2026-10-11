import {randomUUID} from 'node:crypto';
import {nativeChoiceUrl} from '../../native-v2/compact-app/browser-choice.mjs';

const text=value=>typeof value==='string'?value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,' ').trim():'';

// A Task is read with today's permissions. The user's written help is one
// exact existing Task event, not a new participation or an acceptance result.
export function createNativeTaskMenu({call,select,prompt,info,isCurrent,onBack,onReturnWork,readWorkContext,openLink,onFindMethods,searchQuery='',language='zh-CN'}){
 const label=(zh,en)=>language==='en-US'?en:zh;let revision=0,timer=null;
 const current=token=>isCurrent()&&(token===undefined||token===revision);
 const stop=()=>{clearTimeout(timer);timer=null;};
 const show=(title,body,next)=>{stop();const token=++revision;info(title,body,()=>{if(current(token))next();});};
 const menu=(title,entries,back=onBack)=>{stop();const token=++revision,routes={};select({title,options:entries.map(([title,run,description=''],index)=>{routes[index+1]=()=>{if(current(token))run();};return{number:String(index+1),title,description};}),routes,onBack:()=>{if(current(token))back();}});};
 async function read(taskId){const task=await call('galaxy_task_v2_get',{taskId});if(task.taskId!==taskId)throw Error('current_task_unavailable');return task;}
 const body=task=>[
  [label('需要的帮助','Help needed'),text(task.request.summary)],
  [label('目标','Goal'),text(task.request.workContext?.goal)],
  [label('当前情况','Current situation'),text(task.request.workContext?.currentSituation)],
  [label('希望取得','Desired result'),text(task.request.expectedOutcome)],
 ].filter(([,value])=>value).map(([heading,value])=>heading+'\n'+value).join('\n\n');
 async function run(action,done,back){stop();const token=++revision;info('Galaxy',label('正在取得当前内容…','Reading current content…'),()=>{if(current(token)){revision++;back();}});
  try{const value=await action();if(current(token))await done(value);}catch{if(current(token))show(label('暂时无法继续','Unable to continue'),label('暂时无法取得当前内容或执行这次操作。原文字和工作仍保留，可以再试。','Current content or this operation is unavailable. Your text and work are retained; retry when ready.'),back);}}
 function open(taskId){void run(()=>read(taskId),task=>show(text(task.request.title)||label('求助','Request'),body(task),()=>actions(task)),onBack);}
 function actions(task){void run(async()=>({task:await read(task.taskId),status:await call('galaxy_native_status',{})}),({task:fresh,status})=>{
  const application=fresh.contacts?.responses?.applications?.find(row=>row.subjectId===status.identity&&row.state==='pending');
  const canWrite=fresh.schemaVersion===2&&fresh.requesterId!==status.identity&&fresh.enrollmentOpen===true&&fresh.paused===false&&!application;
  menu(text(fresh.request.title)||label('这项求助','This request'),[
   ...(canWrite?[[label('说明我能提供的协助','Describe how I can help'),()=>write(fresh)]]:[]),
   ...(application?[[label('我已发送的协助说明','My sent help'),()=>show(label('已发送给发起者','Sent to the requester'),text(application.proposal),()=>actions(fresh))]]:[]),
   [label('阅读完整求助','Read the request'),()=>open(fresh.taskId)],
   [label('带回原工作','Bring to original work'),()=>bring(fresh.taskId)],
   ...(onFindMethods?[[label('在官网找相关方法','Find related methods on the website'),()=>findMethods(fresh)]]:[]),
  ]);
 },onBack);}
 function findMethods(task){void run(async()=>{
  const fresh=await read(task.taskId),context=await readWorkContext?.();
  const query=text(searchQuery)||text(context?.query)||text(fresh.request.workContext?.goal)||text(fresh.request.summary)||text(fresh.request.title);
  if(!query)throw Error('current_method_query_unavailable');return{taskId:fresh.taskId,query:query.slice(0,200)};
 },onFindMethods,()=>actions(task));}
 function bring(taskId,operationId,methodQuery){void run(async()=>{
  const task=await read(taskId),status=await call('galaxy_native_status',{});
  const application=task.contacts?.responses?.applications?.find(row=>row.subjectId===status.identity&&(!operationId||row.applicationId===operationId));
  return{title:text(task.request.title)||label('求助','Request'),content:body(task)+(application?'\n\n'+label('我已发送的协助说明','My sent help')+'\n'+text(application.proposal)+'\n\n'+label('已发送给发起者，等待回应。','Sent to the requester; awaiting a response.') :'')
    +(methodQuery?'\n\n'+label('继续查找的方法方向','Method search to continue')+'\n'+methodQuery:''),
   ...(status.website?{sourceUrl:new URL(methodQuery?'/app/search?'+new URLSearchParams({q:methodQuery,sourceTask:taskId,returnTo:'/app/tasks/'+taskId+'?section=collaboration'}).toString():'/app/tasks/'+taskId,status.website).href}:{})};
 },onReturnWork,()=>open(taskId));}
 function write(task,draft=''){stop();const token=++revision;prompt({title:label('你可以怎样协助？','How can you help?'),placeholder:'',value:draft,onCancel:()=>actions(task),onConfirm:proposal=>{
  if(!current(token))return;const value=proposal.trim();if(!value||value.length>1500)return show(label('协助说明','Help description'),label('请用 1500 字以内说明你能帮助的部分。原输入仍保留。','Describe how you can help in up to 1500 characters. Your input is retained.'),()=>write(task,proposal));
  void run(async()=>{
   const fresh=await read(task.taskId),context=await readWorkContext?.();
   const session=await call('galaxy_help_start',{localTaskRef:context?.origin?.workRef||label('当前 OpenCode 工作','Current OpenCode work'),caseId:fresh.caseId??null,taskId:fresh.taskId});
   const payloadJson=JSON.stringify({taskId:fresh.taskId,event:{eventId:randomUUID(),kind:'apply',expectedTaskVersion:fresh.version,proposal:value}});
   const preview=await call('galaxy_help_prepare_action',{sessionId:session.id,kind:'task-event',taskId:fresh.taskId,payloadJson});
   return{sessionId:session.id,preview,task:fresh,proposal};
  },execute,()=>write(task,proposal));
 }});}
 function execute(operation){stop();const token=++revision;let busy=false,opened=null;
  const input={sessionId:operation.sessionId,operationId:operation.preview.operationId,payloadHash:operation.preview.payloadHash,authorizationRequestId:operation.preview.authorizationRequestId};
  const retryEditor=()=>write(operation.task,operation.proposal);
  const finish=result=>{
   if(!current())return;
   if(result.receipt?.state==='acknowledged'||result.operation?.state==='acknowledged')return show(label('协助说明已发送','Help description sent'),label('发起者可以看到你的说明。是否一起做事由双方继续交流决定。','The requester can read your description. Further collaboration remains a choice for both of you.'),()=>menu(label('继续这项工作','Continue this work'),[
    [label('带回原工作','Bring to original work'),()=>bring(operation.task.taskId,operation.preview.operationId)],
    [label('查看这项求助','Read this request'),()=>open(operation.task.taskId)],
   ]));
   const state=result.receipt?.state??result.operation?.state??result.state;
   show(label('发送结果尚待确认','Sending needs checking'),state==='conflict'?label('原内容与服务记录不一致。已保留原操作，请在完整求助中核对。','The original content differs from the service record. The original operation is retained; review it in the full request.'):
    label('暂未取得原发送的确认。原文字和定位已保留；再次检查不会另发一条。','The original send is not confirmed yet. Your text and original reference are retained; checking does not send another message.'),()=>menu(label('继续这项协助','Continue this help'),[
     [label('查看当前发送结果','Check this send'),()=>void run(()=>call('galaxy_help_reconcile_action',{sessionId:operation.sessionId,operationId:operation.preview.operationId}),finish,()=>actions(operation.task))],
     ...(state==='absent'?[[label('重试这次发送','Retry this send'),()=>execute(operation)]]:[]),
     [label('回到求助','Return to request'),()=>actions(operation.task)],
    ]));
  };
  const tick=async()=>{
   if(!current(token)||busy)return;busy=true;
   try{const result=await call('galaxy_help_execute_action',input);if(!current(token))return;
    if(result.state==='declined')return show(label('这次发送已取消','This send was canceled'),label('协助说明没有获得发送授权，原输入仍保留。','The help description was not authorized for sending. Your input is retained.'),retryEditor);
    if(result.state==='user-choice-needs-browser'){
     const url=nativeChoiceUrl(result.url);if(!url)throw Error('local_choice_unavailable');
     if(opened!==url){opened=url;await openLink?.(url);if(!current(token))return;
      info(label('发送这份协助说明','Send this help description'),label('请在本机选择页核对原文和发起者。允许后自动继续；取消会保留输入。','Review your original text and the requester on the local choice page. Approval continues automatically; canceling retains your input.')+'\n\n'+url,()=>{if(current(token))void tick();});}
     timer=setTimeout(()=>void tick(),1500);timer.unref?.();return;
    }
    if(result.state==='unknown'||result.operation?.state==='unknown'){
     const receipt=await call('galaxy_help_reconcile_action',{sessionId:operation.sessionId,operationId:operation.preview.operationId});finish(receipt);return;
    }
    finish(result);
   }catch{if(current(token))show(label('这次发送暂时无法继续','Unable to continue this send'),label('当前连接或范围暂不可用。原说明和操作仍保留，可以核对原发送结果；不会另建一次发送。','The current connection or scope is unavailable. Your description and original operation are retained. Check the original result without creating another send.'),()=>menu(label('原协助说明','Original help description'),[
    [label('查看当前发送结果','Check this send'),()=>void run(()=>call('galaxy_help_reconcile_action',{sessionId:operation.sessionId,operationId:operation.preview.operationId}),finish,retryEditor)],
    [label('回到求助','Return to request'),()=>actions(operation.task)],
   ]));}finally{busy=false;}
  };
  info(label('正在准备发送','Preparing to send'),label('核对原求助和这份说明。','Checking the request and your description.'),()=>{if(current(token))void tick();});void tick();
 }
 return{open,bringToWork:(taskId,methodQuery)=>bring(taskId,undefined,methodQuery),close(){revision++;stop();}};
}
