import {automationResourceScope,automationScopeCapability} from '../../shared/operations-automation-scope.mjs';

export const stamp=value=>new Date(value).toISOString();
export const roleView=row=>({id:row.id,name:row.name,description:row.description,enabled:row.enabled,version:row.version,permissions:row.permissions,subjectScope:row.subject_scope??'shared',managedAiAccountIds:row.managed_ai_account_ids??[],createdByAiAccountId:row.created_by_ai_account_id??null,updatedByAiAccountId:row.updated_by_ai_account_id??null,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)});
export async function roleUsageWithin(db,endpoint,roleId){
 const people=(await db.query('SELECT count(*)::integer AS count FROM operations_role_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND enabled',[endpoint,roleId])).rows[0].count;
 const accounts=(await db.query(`SELECT w.id,w.domain,w.name,w.enabled FROM operations_ai_work_assignments_v1 a JOIN operations_ai_work_accounts_v1 w ON w.endpoint=a.endpoint AND w.id=a.ai_account_id WHERE a.endpoint=$1 AND a.role_id=$2 AND a.enabled ORDER BY w.domain,w.id`,[endpoint,roleId])).rows;
 return{usage:{humanAssignments:people,aiAssignments:accounts.length,aiAccounts:accounts},impact:{affectsPeople:people>0,affectsAi:accounts.length>0,assignmentCount:people+accounts.length}};
}
export const assignmentView=row=>({id:row.id,operatorId:row.operator_id,roleId:row.role_id,enabled:row.enabled,version:row.version,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)});
export const automationView=(row,runtime=null,binding=null)=>{
 const ai=row.executor_kind==='ai',actual=binding??{aiAccountId:row.ai_account_id??null,bindingState:ai?(row.ai_account_id?'unavailable':'unassigned'):'not-applicable',aiAccount:null},scopeCapability=automationScopeCapability(row);
 const usable=scopeCapability.canBindObjects&&(!ai||actual.bindingState==='bound'),modelReady=!ai||runtime?.modelState==='configured'&&(!Array.isArray(runtime.configuredDomains)||runtime.configuredDomains.includes(actual.aiAccount?.domain));
 const reasons=[...(scopeCapability.canBindObjects?[]:['object-scope-unresolved']),...(!ai||actual.bindingState==='bound'?[]:[actual.bindingState])],actions=actual.actionReadiness??[],handlerReady=ai?actions.length>0&&actions.every(action=>action.handlerReady):runtime?.state==='connected',ready=handlerReady&&runtime?.state==='connected'&&modelReady;
 return{id:row.id,name:row.name,executorKind:row.executor_kind,mode:row.mode,enabled:row.enabled,version:row.version,permissions:row.permissions,resourceIds:row.resource_ids,...actual,
  authorization:{saved:true,effective:reasons.length===0,reasons},readiness:{ready,reasons:[...(!handlerReady?['handler-not-connected']:[]),...(runtime?.state==='connected'?[]:['runtime-not-connected']),...(modelReady?[]:['model-not-configured'])],actions},
  resourceScope:automationResourceScope(row),scopeCapability,
  executionState:!usable||!handlerReady||!runtime||runtime.state==='not-configured'?'not-connected':runtime.state!=='connected'?'unavailable':!modelReady?'model-not-configured':row.mode==='automatic'?'awaiting-trigger':'connected',
  executionAvailable:!!row.enabled&&ready&&usable&&runtime?.state==='connected'&&row.mode==='assisted'&&modelReady,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)};
};

