import * as z from 'zod/v4';
import {nativeResult} from '../../packages/galaxy-edge-mcp/src/native-v2/choice.mjs';

const latest=rows=>[...new Map((rows??[]).filter(row=>!row.supersededInVisibleHistory).sort((a,b)=>a.version-b.version).map(row=>[row.id,row])).values()];
const attempts=(view,subjectId)=>latest(view.attempts).filter(a=>a.provenance==='native-v2'&&a.actorId===subjectId&&(view.scopeVersion===undefined||a.scopeVersion===view.scopeVersion));

// This is a current, permission-scoped selection of existing work. A history
// row is only a locator; the exact selected facts are read again before use.
export function registerNativeWorkSelectionTools(server,{runtime}){
 const register=(name,schema,description,run)=>server.registerTool(name,{inputSchema:schema,description,annotations:{readOnlyHint:true}},async input=>{
  await runtime.ensureConnection?.();const lease=runtime.receiptStatus.captureLease();try{lease.assertCurrent();const result=await run(input,lease);lease.assertCurrent();return nativeResult(result);}
  catch(error){return{isError:true,...nativeResult({error:error.code??'current_work_unavailable',originalWorkRetained:true})};}
 });
 register('galaxy_work_sources',z.strictObject({after:z.string().max(2400).optional()}),
  'Select current owned v2 work by its readable title; exact Case and Attempt references remain structured. Does not create a fact, send to a peer or grant access.',async(input,lease)=>{
   const page=await runtime.api.call('/v2/history/query',{subjectId:lease.subjectId,limit:7,...input});lease.assertCurrent();
   return{items:(page.items??[]).filter(v=>v.kind==='case-history'&&v.caseId).map(v=>({caseId:v.caseId,title:v.title??'当前工作',summary:v.summary??'',
    synthetic:v.synthetic,attempts:attempts(v,lease.subjectId).map(a=>({id:a.id,version:a.version,strategy:a.strategy,taskId:a.taskId??null}))})).filter(v=>v.attempts.length),nextCursor:page.nextCursor??null};
  });
 register('galaxy_work_read',z.strictObject({caseId:z.uuid(),taskId:z.uuid().optional()}),
  'Reread a selected existing v2 work and its current owned Attempts under the current connection. History and an old receipt never supply current source access.',async({caseId,taskId},lease)=>{
   const view=await runtime.api.call('/v2/cases/'+caseId+'/read',taskId?{taskId}:{});lease.assertCurrent();const event=view.events?.find(e=>e.kind==='case-created');
   return{...view,title:event?.title??'当前工作',summary:event?.summary??'',subjectId:lease.subjectId,selectableAttempts:attempts(view,lease.subjectId)};
  });
}
