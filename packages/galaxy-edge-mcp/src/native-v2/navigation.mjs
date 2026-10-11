import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
export const navigationSchema=z.strictObject({object:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.enum(['task','room','project']),id:z.uuid()}),
 z.strictObject({kind:z.literal('capsule'),id:z.uuid(),versionId:z.uuid().optional()}),
 z.strictObject({kind:z.enum(['match','publish','participate','messages','identity','privacy','search','capsules','summaries','notifications'])})]),
 origin:z.strictObject({host:z.string().min(1).max(80),workRef:z.string().min(1).max(500)}).optional()});
const routes={task:'tasks',room:'rooms',messages:'rooms',project:'projects',capsule:'capsules',capsules:'capsules',match:'match',publish:'publish',participate:'participate',identity:'settings/identity',privacy:'settings/privacy',search:'search',summaries:'settings/summaries',notifications:'notifications'};
const fail=code=>{throw Object.assign(new Error(code),{code});};
const pathFor=object=>'/app/'+routes[object.kind]+(object.id?'/'+object.id:'')+(object.versionId?'/versions/'+object.versionId:'');
const sourceUnavailable=e=>([403,404,410,429].includes(e?.status)||e?.status>=500&&e?.status<600)
 &&!['unauthorized','binding_revoked','invalid_session','session_expired','access_denied'].includes(e?.code??e?.message);
const sourceCode=e=>/^[a-z0-9_:-]{1,100}$/.test(e?.code??e?.message??'')?e.code??e.message:'navigation_source_unavailable';
export function createNativeNavigation({website,store,openBrowser=platformOpen,refresh,captureLease=null,now=()=>Math.floor(Date.now()/1000)}){
 const u=new URL(website);if(u.protocol!=='https:'||u.origin!==website||u.username||u.password)throw new Error('native_website_origin_required');
 if(captureLease!==null&&typeof captureLease!=='function')fail('navigation_lease_invalid');
 async function authority(){if(!captureLease)return{lease:null,owner:null};const lease=await captureLease();
  if(typeof lease?.assertCurrent!=='function'||lease.subjectId!==null&&!/^GUID[0-9A-Z]{28}$/.test(lease.subjectId??''))fail('navigation_lease_invalid');
  let endpoint;try{endpoint=new URL(lease.endpoint);}catch{fail('navigation_lease_invalid');}
  if(endpoint.protocol!=='https:'||endpoint.origin!==lease.endpoint||endpoint.username||endpoint.password)fail('navigation_lease_invalid');
  await lease.assertCurrent();return{lease,owner:{subjectId:lease.subjectId,endpoint:lease.endpoint,website}};
 }
 async function open(input){const parsed=navigationSchema.parse(input),navigationId=randomUUID(),{lease,owner}=await authority();
  if(!routes[parsed.object.kind])return{state:'object-page-unavailable',object:parsed.object,opened:false,businessMutation:false,
   tool:parsed.object.kind==='project'?'galaxy_project_v2_get':'galaxy_capsule_v2_read',reason:'stable-detail-route-not-implemented'};
  const targetPath=pathFor(parsed.object);await lease?.assertCurrent();
  await store.put('navigation:'+navigationId,{navigationId,...parsed,owner,createdAt:now(),targetPath});await lease?.assertCurrent();
  let launch,timer;try{
   const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve({state:'launch-timeout',launched:false}),10000);});
   launch=await Promise.race([Promise.resolve().then(()=>openBrowser(website+targetPath)),timeout]);
  }catch{launch={state:'launch-failed',launched:false};}finally{clearTimeout(timer);}
  await lease?.assertCurrent();
  return{navigationId,targetPath,url:website+targetPath,surface:'browser',...launch,opened:'unverified',businessMutation:false,returnMode:'mcp-refresh',embeddedUi:'unverified'};
 }
 async function resume(navigationId){z.uuid().parse(navigationId);const {lease,owner}=await authority(),row=await store.get('navigation:'+navigationId);await lease?.assertCurrent();
  if(!row)fail('navigation_not_found');
  // Existing unscoped records cannot prove whose private original work they
  // reference. Reopening a stable object creates a new, explicit local scope.
  if(owner){if(!row.owner)fail('navigation_owner_unconfirmed');
   if(['subjectId','endpoint','website'].some(key=>row.owner[key]!==owner[key]))fail('navigation_scope_changed');}
  let parsed;try{parsed=navigationSchema.parse({object:row.object,...(row.origin?{origin:row.origin}:{})});}catch{fail('navigation_reference_invalid');}
  if(row.navigationId!==navigationId||row.targetPath!==pathFor(parsed.object))fail('navigation_reference_invalid');
  let data=null,sourceError=null,current=false;
  if(parsed.object.id){try{
   data=await refresh(parsed.object);await lease?.assertCurrent();
   const field=parsed.object.kind+'Id';
   if(owner&&(data?.[field]!==parsed.object.id||parsed.object.versionId&&data?.versionId!==parsed.object.versionId))fail('navigation_source_reference_mismatch');
   current=true;
  }catch(e){await lease?.assertCurrent();if(!sourceUnavailable(e))throw e;data=null;sourceError=sourceCode(e);}}
  await lease?.assertCurrent();
  return{navigationId,origin:parsed.origin??null,object:parsed.object,data,current,sourceError,
   state:sourceError?'unavailable':current?'refreshed':'navigation-only',businessMutation:false,returnedToHost:'host-controlled',closedWindowDoesNotCancel:true};
 }
 // Prepare the same scoped original record without launching a second window.
 // The identity bridge uses this before its own explicit browser user surface.
 async function prepare(input){
  const parsed=navigationSchema.parse(input),navigationId=randomUUID(),{lease,owner}=await authority();
  if(!routes[parsed.object.kind])fail('navigation_reference_invalid');
  const targetPath=pathFor(parsed.object);await lease?.assertCurrent();
  await store.put('navigation:'+navigationId,{navigationId,...parsed,owner,createdAt:now(),targetPath});await lease?.assertCurrent();
  return{navigationId,targetPath,url:website+targetPath,object:parsed.object,state:'prepared',businessMutation:false,opened:false,returnMode:'mcp-refresh'};
 }
 return{open,resume,prepare};
}
async function platformOpen(url){const command=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';
 return new Promise(resolve=>{const child=spawn(command,[url],{windowsHide:true,detached:true,stdio:'ignore'});
  child.once('error',()=>resolve({state:'launch-failed',launched:false}));child.once('spawn',()=>{child.unref();resolve({state:'launch-requested',launched:true});});});}
