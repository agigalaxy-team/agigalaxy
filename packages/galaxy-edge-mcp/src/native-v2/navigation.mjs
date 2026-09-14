import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
export const navigationSchema=z.strictObject({object:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.enum(['task','room','project']),id:z.uuid()}),
 z.strictObject({kind:z.literal('capsule'),id:z.uuid(),versionId:z.uuid().optional()}),
 z.strictObject({kind:z.enum(['match','publish','participate','identity','privacy','search','capsules','summaries','notifications'])})]),
 origin:z.strictObject({host:z.string().min(1).max(80),workRef:z.string().min(1).max(500)}).optional()});
const routes={task:'tasks',room:'rooms',project:'projects',capsule:'capsules',capsules:'capsules',match:'match',publish:'publish',participate:'participate',identity:'settings/identity',privacy:'settings/privacy',search:'search',summaries:'settings/summaries',notifications:'notifications'};
export function createNativeNavigation({website,store,openBrowser=platformOpen,refresh,now=()=>Math.floor(Date.now()/1000)}){
 const u=new URL(website);if(u.protocol!=='https:'||u.origin!==website||u.username||u.password)throw new Error('native_website_origin_required');
 async function open(input){const parsed=navigationSchema.parse(input),navigationId=randomUUID();
  if(!routes[parsed.object.kind])return{state:'object-page-unavailable',object:parsed.object,opened:false,businessMutation:false,
   tool:parsed.object.kind==='project'?'galaxy_project_v2_get':'galaxy_capsule_v2_read',reason:'stable-detail-route-not-implemented'};
  const targetPath='/app/'+routes[parsed.object.kind]+(parsed.object.id?'/'+parsed.object.id:'')+(parsed.object.versionId?'/versions/'+parsed.object.versionId:'');
  await store.put('navigation:'+navigationId,{navigationId,...parsed,createdAt:now(),targetPath});
  let launch;try{
   let timer;const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve({state:'launch-timeout',launched:false}),10000);});
   launch=await Promise.race([Promise.resolve().then(()=>openBrowser(website+targetPath)),timeout]);clearTimeout(timer);
  }catch{launch={state:'launch-failed',launched:false};}
  return{navigationId,targetPath,url:website+targetPath,surface:'browser',...launch,opened:'unverified',businessMutation:false,returnMode:'mcp-refresh',embeddedUi:'unverified'};
 }
 async function resume(navigationId){z.uuid().parse(navigationId);const row=await store.get('navigation:'+navigationId);if(!row)throw new Error('navigation_not_found');
  const data=row.object.id?await refresh(row.object):null;
  return{navigationId,origin:row.origin??null,object:row.object,data,businessMutation:false,returnedToHost:'host-controlled',closedWindowDoesNotCancel:true};
 }
 return{open,resume};
}
async function platformOpen(url){const command=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';
 return new Promise(resolve=>{const child=spawn(command,[url],{windowsHide:true,detached:true,stdio:'ignore'});
  child.once('error',()=>resolve({state:'launch-failed',launched:false}));child.once('spawn',()=>{child.unref();resolve({state:'launch-requested',launched:true});});});}
