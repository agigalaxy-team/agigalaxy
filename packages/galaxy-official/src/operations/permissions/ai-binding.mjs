import {ServiceError} from '../../shared/service-error.mjs';
import {automationEligibleActions} from '../../shared/operations-automation-scope.mjs';
import {aiWorkCapabilities} from '../accounts/ai-work-schema.mjs';
import {aiActionProjection} from '../../shared/operations-ai-action-registry.mjs';

const fail=(code,status)=>{throw new ServiceError(code,status);};
const accountView=row=>({id:row.id,domain:row.domain,name:row.name,enabled:row.enabled});
async function accountWithin(db,endpoint,id){return(await db.query('SELECT id,domain,name,enabled FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND id=$2',[endpoint,id])).rows[0]??null;}

// The existing permissions editor owns this small purpose-bound directory.
// It does not borrow the AI-account maintenance page's separate read authority.
export async function automationAiOptionsWithin(db,{endpoint,aiWorkAccounts,actor}){
 if(!aiWorkAccounts)return{state:'unavailable',items:[]};
 const rows=(await db.query('SELECT id,domain,name,enabled FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 ORDER BY domain,id',[endpoint])).rows,items=[];
 for(const row of rows){const current=await aiWorkAccounts.authorizationWithin(db,row.domain,{accountId:row.id});
  const rolePermissions=aiWorkCapabilities(row.domain,current.permissions).autonomousPermissions.filter(code=>automationEligibleActions.includes(code));
  const executablePermissions=rolePermissions.filter(code=>actor.businessAuthorization.permissions.includes(code));
  const unavailableReason=!current.enabled?'account-disabled':!rolePermissions.length?'role-missing':!actor.businessAuthorization.permissions.includes('permissions.automation.write')?'assignment-denied':!executablePermissions.length?'exceeds-permissions':null;
  const permissions=current.permissions.filter(code=>actor.businessAuthorization.permissions.includes(code));
  items.push({...accountView(row),permissions,rolePermissions,executablePermissions,readiness:rolePermissions.map(permission=>aiActionProjection(permission,{permissions,handlerReady:aiWorkAccounts.businessAdmin?.executorAuthority?.dutyActionReady?.(permission)===true})),canSave:actor.businessAuthorization.permissions.includes('permissions.automation.write'),canEnable:current.enabled&&executablePermissions.length>0&&actor.businessAuthorization.permissions.includes('permissions.automation.write'),unavailableReason});
 }
 return{state:'available',items};
}
export async function automationAiBindingWithin(db,{endpoint,aiWorkAccounts,row}){
 if(row.executor_kind!=='ai')return{aiAccountId:null,bindingState:'not-applicable',aiAccount:null};
 const aiAccountId=row.ai_account_id??null;
 if(!aiAccountId)return{aiAccountId:null,bindingState:'unassigned',aiAccount:null};
 const account=await accountWithin(db,endpoint,aiAccountId),aiAccount=account?accountView(account):null;
 if(!account||!aiWorkAccounts)return{aiAccountId,bindingState:'unavailable',aiAccount};
 const current=await aiWorkAccounts.authorizationWithin(db,account.domain,{accountId:aiAccountId});
 const supported=aiWorkCapabilities(account.domain,current.enabled?current.permissions:[]).autonomousPermissions;
 const bindingState=!current.enabled?'disabled':!row.permissions.length||row.permissions.some(code=>!automationEligibleActions.includes(code))?'unsupported':row.permissions.some(code=>!supported.includes(code))?'role-exceeded':'bound';
 const actionReadiness=row.permissions.map(permission=>aiActionProjection(permission,{permissions:current.enabled?current.permissions:[],handlerReady:aiWorkAccounts.businessAdmin?.executorAuthority?.dutyActionReady?.(permission)===true}));
 return{aiAccountId,bindingState,aiAccount,actionReadiness};
}
export async function automationAiIdForSaveWithin(db,{endpoint,input,old}){
 const id=input.aiAccountId!==undefined?input.aiAccountId:old?.ai_account_id??null;
 if(input.executorKind==='program'){if(id!==null)fail('operations_automation_ai_binding_invalid',400);return null;}
 if(id===null){if(input.enabled)fail('operations_automation_ai_binding_required',400);return null;}
 if(!await accountWithin(db,endpoint,id))fail('operations_automation_ai_account_not_found',404);
 // This stores the human's bounded intent. Current account/role/handler/model
 // availability determines effectiveness at execution, not whether an existing
 // grant can be named or saved while one of those dependencies is unavailable.
 return id;
}


