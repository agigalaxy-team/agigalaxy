import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {getFactClient} from '../../galaxy-web/src/fact-client.mjs';
import {createRecoveryMaterial} from '../../galaxy-core/src/domain/identity-material.mjs';

export const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
export const outcome=promise=>promise.then(value=>({value}),error=>({error}));
export const intervention=()=>({kind:'intervention',types:['diagnosis'],affectsAttemptIds:[],
 description:'PRIVATE FICTIONAL bounded diagnostic fact',sourceRefs:[],observedEffect:'No actual external work'});
function memoryStore(values,{get:onGet,put:onPut}={}){
 const get=async key=>{const value=structuredClone(values.get(key));await onGet?.(key,value);return value;};
 const put=async(key,value)=>{values.set(key,structuredClone(value));await onPut?.(key,value);};
 const update=async(key,fn)=>{
  const next=fn(structuredClone(values.get(key)));
  if(next&&typeof next.then==='function')throw Error('local_atomic_updater_must_be_synchronous');
  values.set(key,structuredClone(next));await onPut?.(key,next);return structuredClone(next);
 };
 return{get,put,update,async prepareRecovery(subjectId,operationId){const key='pending-recovery:'+subjectId+':'+operationId;
  let v=await get(key);if(!v){v={...await createRecoveryMaterial(subjectId),operationId};await put(key,v);}return v;},
  async declareSaved(subjectId,id){const key='pending-recovery:'+subjectId+':'+id;await put(key,{...await get(key),saveDeclared:true});},
  async recordReceipt(subjectId,id,receipt){const key='pending-recovery:'+subjectId+':'+id;await put(key,{...await get(key),receipt});}};
}
// Real WebRuntime/device JWS/Consent/HTTP/PGlite. Journal is deliberately a
// Map contract fixture, not IndexedDB. Account quotas are an explicit fixture;
// these private synthetic Task tests do not prove public Account verification.
export async function factContinuityFixture(){
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:2000}),data=new Map(),calls=[],runtimes=[];
 let runtime,origin,onGet,onPut,fault=null,offline=false;
 const start=async store=>{
  const r=await createExistingWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{now:()=>f.now,store,fetch:async(url,options)=>{
   const parsed=new URL(url),path=parsed.pathname;calls.push({path,method:options.method??'GET'});
   if(offline&&path.endsWith('/receipt'))throw new Error('Fictional readonly receipt offline');
   const selected=fault?.path===path;if(selected&&fault.mode==='before'){fault=null;throw new Error('Fictional failure before dispatch');}
   const response=await fetch(origin+path+parsed.search,options);
   if(selected&&fault.mode==='after'){fault=null;assert.equal(response.status,200);await response.text();throw new Error('Fictional caller ACK lost after actual commit');}
   return response;
  }});runtimes.push(r);return r;
 };
 try{
  await new Promise(r=>api.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+api.address().port;
  runtime=await start(memoryStore(data,{get:(...args)=>onGet?.(...args),put:(...args)=>onPut?.(...args)}));
  await runtime.connect({confirmed:true});
  const subjectId=runtime.api.snapshot().subjectId,client=getFactClient(runtime,subjectId);
  const seedTask=async(link=true)=>{
   const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'FICTIONAL fact client continuity',
    summary:'Synthetic only',workContext:{goal:'Bounded original facts',currentSituation:'No failure',attemptRefs:[]},
    visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+3600};
   await runtime.api.call('/v2/tasks',await runtime.api.authorizePayload(task,{action:'assistance.publish',objectId:task.operationId,
    visibility:'Private',viewers:[],confirmed:true,expiresAt:f.now+3600}));
   let current=await runtime.api.call('/v2/tasks/'+task.taskId,null,{method:'GET'});
   if(link){await client.submitFact(current,null,null,intervention(),{confirmed:true,viewers:[],caseSummary:'FICTIONAL original Case',synthetic:true});
    current=await runtime.api.call('/v2/tasks/'+task.taskId,null,{method:'GET'});}
   return current;
  };
  const fields=()=>({kind:'evidence',expectedVersion:0,evidenceType:'self-assertion',synthetic:true,
   source:{originSystem:'fictional-client-continuity',externalStableId:randomUUID(),contentVersion:'1',
    originalAt:new Date(f.now*1000).toISOString(),issuer:'FICTIONAL source'},
   observedAt:new Date(f.now*1000).toISOString(),reportedSourceState:'available',summary:'PRIVATE FICTIONAL evidence'});
  const pendingKey=taskId=>'task-fact-pending:'+subjectId+':'+taskId;
  const archiveKey=taskId=>'task-fact-receipts:'+subjectId+':'+taskId;
  const bodyWrites=()=>calls.filter(c=>c.path==='/v2/verification-records/submit'||c.path==='/v2/cases/events'||/\/v2\/tasks\/[^/]+\/case$/.test(c.path));
  const switchOwner=async()=>{
   const other=await start(memoryStore(new Map()));await other.connect({confirmed:true});
   const material=await other.prepareRecovery();await other.saveRecovery({operationId:material.operationId,confirmed:true});
   const recovered=await runtime.recover(material.code,{confirmed:true});await runtime.confirmRecoveredCode({operationId:recovered.operationId,confirmed:true});await runtime.connect({confirmed:true});
  };
  return{f,runtime,client,subjectId,calls,seedTask,fields,bodyWrites,pendingKey,archiveKey,switchOwner,
   onGet:fn=>{onGet=fn;},onPut:fn=>{onPut=fn;},offline:v=>{offline=v;},fault:(path,mode)=>{fault={path,mode};},
   pendingRaw:taskId=>runtime.getLocal(pendingKey(taskId),subjectId),
   archive:taskId=>runtime.getLocal(archiveKey(taskId),subjectId),
   revokeRoot:async task=>{const c=(await f.db.query('SELECT consent_id FROM case_events WHERE id=$1',[task.caseId])).rows[0];
    await runtime.api.call('/v1/consents/'+c.consent_id+'/revoke',{});},
   original:async operationId=>(await f.db.query('SELECT operation_id,payload_hash,payload_text,consent_id,version FROM verification_events WHERE operation_id=$1',[operationId])).rows[0],
   close:async()=>{runtimes.forEach(r=>r.close());api.closeAllConnections();await new Promise(r=>api.close(r));await f.db.close();}};
 }catch(error){runtimes.forEach(r=>r.close());if(api.listening){api.closeAllConnections();await new Promise(r=>api.close(r));}await f.db.close();throw error;}
}
