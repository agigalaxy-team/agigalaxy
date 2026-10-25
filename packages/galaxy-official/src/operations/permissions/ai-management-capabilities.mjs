import {z} from 'zod';
import {operationsAiWorkScope} from '../../shared/operations-ai-use.mjs';
import {fail} from './helpers.mjs';

const feature=z.strictObject({permission:z.string(),systemSupport:z.enum(['connected','not-connected','human-only']),permissionAllowed:z.boolean(),delegated:z.boolean(),available:z.boolean(),confirmation:z.enum(['read-tool','operation-card','autonomous-tool','human-console']),reasons:z.array(z.enum(['permission-missing','delegation-missing','handler-not-connected','human-only','task-scope-missing','human-required'])).max(6)});
export const aiManagementCapabilitiesSchema=z.strictObject({schemaVersion:z.literal(1),sourceAiAccountId:z.uuid(),
 delegation:z.strictObject({id:z.uuid().nullable(),version:z.number().int().positive().nullable(),enabled:z.boolean()}),
 targetAiAccounts:z.array(z.strictObject({id:z.uuid(),domain:z.enum(['governance','messaging','discovery','maintenance']),name:z.string().max(100),enabled:z.boolean()})).max(4),
 role:z.strictObject({read:feature,create:feature,update:feature,assign:feature,revoke:feature}),
 prompt:z.strictObject({scope:z.literal('role-work-requirements'),read:feature,update:feature}),
 ordinaryStrategy:z.strictObject({configure:feature,publish:feature}),modelConfiguration:feature,authorityBoundaries:feature});

// Capability facts deliberately contain no target prompt, credential or policy
// body. The dedicated read tool authorizes each requested target separately.
export async function managementCapabilitiesWithin(owner,db,{actor}){
 const authority=owner.aiServiceAuthority,duty=authority?.acceptsDuty(actor),work=duty?null:operationsAiWorkScope(actor);if(!authority||!duty&&!work)fail('business_admin_denied');
 const sourceAiAccountId=duty?actor.aiAccountId:work.accountId,query=duty?await authority.requireDutyAction(actor,'workbench.read',{db,purpose:'query'}):await authority.human(actor,{db,action:'workbench.read',purpose:'query'}),
  prepared=duty?await authority.requireDutyAction(actor,'workbench.read',{db,purpose:'execution'}):await authority.human(actor,{db,action:'workbench.read',purpose:'prepare'}),
  availability=await owner.delegationAvailabilityWithin(db,{actor}),row=await owner.aiRoleDelegation.current(db,sourceAiAccountId),targets=[];
 const task=duty?(await db.query('SELECT configuration,mode FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2 AND ai_account_id=$3',[owner.endpoint,authority.dutyContext(actor).taskId,sourceAiAccountId])).rows[0]:null;
 const allowed=(permission,read=false)=>(read?query:prepared).businessAuthorization.permissions.includes(permission),active=availability.delegationId!==null,
  fact=(permission,{read=false,delegated=true,humanOnly=false,connected=true}={})=>{
   const permissionAllowed=allowed(permission,read),systemSupport=humanOnly?'human-only':connected?'connected':'not-connected',reasons=[],taskScoped=!duty||read||humanOnly||task?.configuration?.plan?.actions?.includes(permission)===true,automatic=!duty||read||humanOnly||['ai','code'].includes(task?.mode);
   if(!permissionAllowed)reasons.push('permission-missing');if(!delegated)reasons.push('delegation-missing');if(!connected&&!humanOnly)reasons.push('handler-not-connected');if(humanOnly)reasons.push('human-only');
   if(!taskScoped)reasons.push('task-scope-missing');if(!automatic)reasons.push('human-required');
   return{permission,systemSupport,permissionAllowed,delegated,available:permissionAllowed&&delegated&&connected&&!humanOnly&&taskScoped&&automatic,confirmation:humanOnly||!automatic?'human-console':read?'read-tool':duty?'autonomous-tool':'operation-card',reasons};
  };
 if(availability.canReadRoles||availability.canReadPrompts)for(const id of availability.targetAiAccountIds)targets.push(await owner.aiRoleDelegation.account(db,id));
 const role={read:fact('ai.roles.read',{read:true,delegated:active&&row.allowed_management_actions.includes('read')})};for(const action of ['create','update','assign','revoke'])role[action]=fact('ai.roles.'+action,{delegated:active&&row.allowed_management_actions.includes(action)});
 const result={schemaVersion:1,sourceAiAccountId,delegation:{id:availability.delegationId,version:availability.version,enabled:active},targetAiAccounts:targets,role,
  prompt:{scope:'role-work-requirements',read:fact('ai.prompts.read',{read:true,delegated:active&&row.allowed_management_actions.includes('prompt-read')}),update:fact('ai.prompts.update',{delegated:active&&row.allowed_management_actions.includes('prompt-update')})},
  ordinaryStrategy:{configure:fact('strategies.ordinary.configure',{connected:authority.dutyActionReady?.('strategies.ordinary.configure')===true}),publish:fact('strategies.ordinary.publish',{connected:authority.dutyActionReady?.('strategies.ordinary.publish')===true})},
  modelConfiguration:fact('models.configure',{humanOnly:true}),authorityBoundaries:fact('ai.delegation.configure',{humanOnly:true})};
 if(!duty){
  // A concrete human card must first read the current configuration and its
  // delegated evidence. Keep the write right itself separate from readiness.
  const requireRead=(write,read)=>{write.available=write.available&&read.available;if(!read.available)write.reasons=[...new Set(write.reasons.concat(read.reasons))];};
  requireRead(result.prompt.update,result.prompt.read);for(const action of ['create','update','assign','revoke'])requireRead(result.role[action],result.role.read);
  const strategyRead=fact('strategies.read',{read:true});for(const action of ['configure','publish'])requireRead(result.ordinaryStrategy[action],strategyRead);
 }
 return aiManagementCapabilitiesSchema.parse(result);
}
