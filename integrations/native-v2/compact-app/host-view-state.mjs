import {createHash} from 'node:crypto';
import * as z from 'zod/v4';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mode=z.enum(['inline','fullscreen','pip']);
const base={hostName:z.string().trim().min(1).max(160),ownerScope:z.string().regex(/^[a-f0-9]{64}$/)};
export const hostViewStateSchema=z.discriminatedUnion('action',[
 z.strictObject({...base,action:z.literal('read')}),
 z.strictObject({...base,action:z.literal('save'),expectedRevision:z.number().int().nonnegative(),mode}),
 z.strictObject({...base,action:z.literal('reset'),expectedRevision:z.number().int().nonnegative()})
]);
export const hostViewOwnerScope=lease=>digest([lease.subjectId,lease.deviceId??null,lease.endpoint,lease.bindingId,lease.generation]);
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function createHostViewState(runtime){
 let closed=false;
 async function run(input){
  const x=hostViewStateSchema.parse(input),lease=runtime.receiptStatus.captureLease();
  const check=()=>{if(closed)fail('host_view_closed');lease.assertCurrent();if(!lease.subjectId||!lease.endpoint||hostViewOwnerScope(lease)!==x.ownerScope)fail('host_view_owner_changed');};check();
  const key='host-view-state:'+digest([lease.subjectId,lease.endpoint,x.hostName]);
  let stored;
  if(x.action==='read'){stored=await runtime.store.get(key);check();}
  else{
   // NativeStore.update takes its cross-process filesystem lock before this
   // synchronous callback. Recheck both the owner and revision inside it.
   stored=await runtime.store.update(key,old=>{check();if((old?.revision??0)!==x.expectedRevision)fail('host_view_revision_conflict');return{schemaVersion:1,revision:x.expectedRevision+1,mode:x.action==='reset'?null:x.mode};});check();
  }
  if(stored&&(stored.schemaVersion!==1||!Number.isSafeInteger(stored.revision)||stored.revision<1||stored.mode!==null&&!mode.safeParse(stored.mode).success))fail('host_view_record_invalid');
  return{kind:'galaxy-host-view-state',ownerScope:x.ownerScope,hostName:x.hostName,revision:stored?.revision??0,mode:stored?.mode??null,scope:'this-device-only',businessMutation:false};
 }
 return{run,close:()=>{closed=true;}};
}
