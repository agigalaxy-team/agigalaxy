const base='https://galaxy.invalid';
/** @param {unknown} value @returns {value is string} */
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const fail=message=>{throw Error(message);};
const originRoute=path=>['/app/search','/app/match','/app/publish','/app/capsules'].includes(path)||/^\/app\/capsules\/[a-f0-9-]{36}(?:\/versions\/[a-f0-9-]{36})?$/i.test(path);
export function taskOriginReturn(taskId,value){
 if(!uuid(taskId))return null;
 try{if(typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//')){const url=new URL(value,base);if(url.origin===base&&url.pathname===`/app/tasks/${taskId}`)return url.pathname+url.search+url.hash;}}catch{}
 return `/app/tasks/${taskId}?section=collaboration`;
}
// Route values are locators only. Current ownership and source access are read
// again before they can become an explicitly selected publication origin.
export function helpOriginLocator(value){
 try{const url=new URL(value,base);if(url.origin!==base)return null;
  const direct=/^\/app\/tasks\/([a-f0-9-]{36})$/i.exec(url.pathname)?.[1];
  if(uuid(direct))return{taskId:direct,returnTo:taskOriginReturn(direct,url.pathname+url.search+url.hash)};
  if(!originRoute(url.pathname))return null;
  const taskId=url.searchParams.get('sourceTask');return uuid(taskId)?{taskId,returnTo:taskOriginReturn(taskId,url.searchParams.get('returnTo'))}:null;
 }catch{return null;}
}
export function carryHelpOrigin(target,from){
 try{if(typeof target!=='string'||!target.startsWith('/')||target.startsWith('//'))return target;
  const url=new URL(target,base);if(url.origin!==base||!originRoute(url.pathname))return target;
  const origin=helpOriginLocator(from);if(!origin)return target;
  url.searchParams.set('sourceTask',origin.taskId);url.searchParams.set('returnTo',origin.returnTo);return url.pathname+url.search+url.hash;
 }catch{return target;}
}
export function helpOriginPayload(selection){
 if(!selection)return{caseId:null,attemptRefs:[]};
 if(!uuid(selection.taskId)||selection.caseId!==null&&!uuid(selection.caseId)||!Array.isArray(selection.attemptRefs)||selection.attemptRefs.length>32
  ||selection.attemptRefs.some(ref=>!uuid(ref?.id)||!Number.isSafeInteger(ref.version)||ref.version<1)
  ||new Set(selection.attemptRefs.map(ref=>ref.id+':'+ref.version)).size!==selection.attemptRefs.length||!selection.caseId&&selection.attemptRefs.length)
  fail('原工作引用不完整，请重新读取并明确选择。');
 return{parentTaskId:selection.taskId,caseId:selection.caseId,attemptRefs:selection.attemptRefs.map(({id,version})=>({id,version}))};
}
export function selectHelpOrigin(view,returnTo,attemptRefs=[]){
 const selection={ownerId:view.ownerId,endpoint:view.endpoint,taskId:view.task.taskId,caseId:view.task.caseId??null,attemptRefs:attemptRefs.map(({id,version})=>({id,version})),returnTo:taskOriginReturn(view.task.taskId,returnTo)};
 helpOriginPayload(selection);return selection;
}
export function createHelpOriginClient(runtime){
 const owner=runtime.api.snapshot(),endpoint=runtime.api.endpoint,lease=runtime.receiptStatus.captureLease();let closed=false;
 const check=()=>{lease.assertCurrent();const current=runtime.api.snapshot();if(closed||!owner||owner.subjectId!==lease.subjectId||runtime.api.endpoint!==endpoint||['subjectId','bindingId','generation'].some(key=>owner[key]!==current?.[key]))fail('身份或连接已改变，请重新核对原工作。');};
 const wait=async fn=>{check();try{const value=await fn();check();return value;}catch(error){check();throw error;}};
 async function read(taskId){
  if(!uuid(taskId))fail('原工作位置不完整。');
  const task=await wait(()=>runtime.api.call(`/v2/tasks/${taskId}`,null,{method:'GET',authenticated:true}));
  if(task.taskId!==taskId||task.schemaVersion!==2||task.requesterId!==owner.subjectId)fail('只能关联当前身份自己发起的原工作。');
  const facts=task.caseId?await wait(()=>runtime.api.call(`/v2/cases/${task.caseId}/read`,{taskId},{authenticated:true})):null;
  if(facts&&facts.caseId!==task.caseId)fail('原工作与案例不一致，请重新读取。');
  return{ownerId:owner.subjectId,endpoint,task,facts,attempts:facts?.attempts??[]};
 }
 async function validate(selection){
  helpOriginPayload(selection);check();
  if(selection.ownerId!==owner.subjectId||selection.endpoint!==endpoint)fail('这份原工作选择不属于当前身份或服务，请重新选择。');
  const current=await read(selection.taskId);
  if((current.task.caseId??null)!==selection.caseId)fail('原工作关联的案例已变化，请重新读取并选择。');
  if(selection.attemptRefs.some(ref=>!current.attempts.some(value=>value.id===ref.id&&value.version===ref.version)))fail('选定的原尝试版本当前不可读取。请核对原工作，或明确取消该引用；不会自动移除后发布。');
  return current;
 }
 return Object.freeze({read,validate,check,close:()=>{closed=true;}});
}
