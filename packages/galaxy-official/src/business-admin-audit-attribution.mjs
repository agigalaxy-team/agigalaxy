import {z} from 'zod';

const uuid=z.uuid(),version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 domain=z.enum(['overview','governance','messaging','discovery','maintenance']);
export const businessAuditActorContextSchema=z.strictObject({schemaVersion:z.literal(1),aiAccountId:uuid,domain,taskId:uuid,planId:uuid,planVersion:version,
 grantId:uuid.optional(),grantVersion:version.optional(),strategyId:uuid.optional(),strategyVersionId:uuid.optional(),toolCallId:uuid.optional(),toolOperationId:uuid.optional(),judgmentKind:z.enum(['ai','code']).optional()});
const nullable=schema=>schema.nullable();
export const businessAuditAttributionSchema=z.strictObject({schemaVersion:z.literal(1),
 aiAccountId:nullable(uuid),aiAccountName:nullable(z.string().trim().min(1).max(120)),domain:nullable(domain),
 initiatorKind:z.enum(['human','schedule','business-event','recovery','unknown']),initiatorOperatorId:nullable(z.string().min(1).max(1024)),initiatorDisplayName:nullable(z.string().trim().min(1).max(120)),
 decisionSource:z.enum(['human','human-confirmed','ai','code','unknown']),decisionBasis:z.enum(['authenticated-human','confirmed-operation-card','verified-native-tool','server-rule','not-recorded']),
 taskId:nullable(uuid),taskSource:nullable(z.enum(['workbench','routine','event','recovery'])),taskReadable:z.boolean(),cardId:nullable(uuid),
 planId:nullable(uuid),planVersion:nullable(version),grantId:nullable(uuid),grantVersion:nullable(version),strategyId:nullable(uuid),strategyVersionId:nullable(uuid)});
const validUuid=value=>uuid.safeParse(value).success,aiId=actorId=>typeof actorId==='string'&&actorId.startsWith('ai:')&&validUuid(actorId.slice(3))?actorId.slice(3):null;
const cleanName=value=>typeof value==='string'&&value.trim()&&value.trim().length<=120?value.trim():null;
export function businessAuditActorContext(authority,actor){
 if(actor?.kind!=='operations-ai-service')return null;
 // No JSON actor, caller selection or model output is a source credential.
 if(!authority?.acceptsDuty(actor))throw new Error('business_admin_audit_actor_unattested');
 const context=authority.dutyContext(actor),bound=context.operation??{},source=context.auditSource??{};
 return businessAuditActorContextSchema.parse({schemaVersion:1,aiAccountId:actor.aiAccountId,domain:actor.domain,taskId:context.taskId,planId:context.planId,planVersion:context.planVersion,
  ...Object.fromEntries(['grantId','grantVersion','strategyId','strategyVersionId'].filter(key=>bound[key]!==null&&bound[key]!==undefined).map(key=>[key,bound[key]])),
  ...(source.callId?{toolCallId:source.callId,toolOperationId:source.operationId,judgmentKind:source.kind}:{})});
}
export function baseBusinessAuditAttribution(row){
 const human=row.actor_kind==='business-operator',id=row.actor_kind==='operations-ai-service'?aiId(row.operator_id):null;
 return {schemaVersion:1,aiAccountId:id,aiAccountName:null,domain:null,
  initiatorKind:human?'human':'unknown',initiatorOperatorId:human?row.operator_id:null,initiatorDisplayName:human?cleanName(row.operator_display_name):null,
  decisionSource:human?'human':'unknown',decisionBasis:human?'authenticated-human':'not-recorded',
  taskId:null,taskSource:null,taskReadable:false,cardId:null,planId:null,planVersion:null,grantId:validUuid(row.grant_id)?row.grant_id:null,grantVersion:null,strategyId:null,strategyVersionId:null};
}

/** Audit permission exposes closed provenance, never task prompts, card bodies
 * or tool arguments. Task navigation still requires current autonomy.read. */
export async function withBusinessAuditAttribution(db,{endpoint,rows,canReadTasks=false}){
 if(!rows.length)return rows;
 const operationIds=[...new Set(rows.map(row=>row.operation_id).filter(validUuid))],contexts=new Map(rows.map(row=>{
  const parsed=businessAuditActorContextSchema.safeParse(row.actor_context);return[row.id,parsed.success&&row.actor_kind==='operations-ai-service'&&row.operator_id==='ai:'+parsed.data.aiAccountId?parsed.data:null];
 }));
 const callIds=[...new Set([...contexts.values()].filter(x=>x?.toolCallId).map(x=>x.toolCallId))];
 const [duties,cards,runs,calls]=await Promise.all([
  operationIds.length?db.query('SELECT operation_id,task_id,ai_account_id FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=ANY($2::uuid[])',[endpoint,operationIds]).then(r=>r.rows):[],
  operationIds.length?db.query(`SELECT id,operator_id,operation_id,turn_id,
   CASE WHEN jsonb_typeof(result->'confirmationAttemptedAt')='string' THEN result->>'confirmationAttemptedAt' ELSE NULL END AS confirmed_at
   FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND operation_id=ANY($2::uuid[])`,[endpoint,operationIds]).then(r=>r.rows):[],
  operationIds.length?db.query(`SELECT r.task_id,r.turn_operation_id FROM operations_autonomy_workbench_runs_v1 r
   JOIN operations_agentos_conversation_cards_v1 c ON c.endpoint=r.endpoint AND c.turn_id=r.turn_operation_id
   WHERE r.endpoint=$1 AND c.operation_id=ANY($2::uuid[])`,[endpoint,operationIds]).then(r=>r.rows):[],
  callIds.length?db.query('SELECT task_id,call_id,operation_id FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND call_id=ANY($2::uuid[])',[endpoint,callIds]).then(r=>r.rows):[]]);
 const taskIds=[...new Set([...contexts.values()].filter(Boolean).map(x=>x.taskId).concat(duties.map(x=>x.task_id),cards.map(x=>x.turn_id),runs.map(x=>x.task_id)))];
 const tasks=taskIds.length?(await db.query(`SELECT id,ai_account_id,domain,source,configuration#>>'{externalWorkbench,operatorId}' AS initiator_id
  FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[])`,[endpoint,taskIds])).rows:[];
 const aiIds=[...new Set(rows.map(row=>aiId(row.operator_id)).concat(tasks.map(x=>x.ai_account_id)).filter(validUuid))],
  accounts=aiIds.length?(await db.query('SELECT id,domain,name FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[])',[endpoint,aiIds])).rows:[],
  initiators=[...new Set(tasks.map(x=>x.initiator_id).filter(x=>typeof x==='string'&&x.length<=1024))],
  people=initiators.length?(await db.query('SELECT operator_id,display_name FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=ANY($2::text[])',[endpoint,initiators])).rows:[];
 return rows.map(row=>{
  const attribution=baseBusinessAuditAttribution(row),context=contexts.get(row.id),human=row.actor_kind==='business-operator',
   duty=duties.find(x=>x.operation_id===row.operation_id&&row.actor_kind==='operations-ai-service'&&row.operator_id==='ai:'+x.ai_account_id),
   card=cards.find(x=>x.operation_id===row.operation_id&&human&&x.operator_id===row.operator_id),
   task=tasks.find(x=>context?x.id===context.taskId&&x.ai_account_id===context.aiAccountId&&x.domain===context.domain:
    duty?x.id===duty.task_id&&x.ai_account_id===duty.ai_account_id:
    card?(x.id===card.turn_id||runs.some(run=>run.task_id===x.id&&run.turn_operation_id===card.turn_id))&&x.initiator_id===card.operator_id:false),
   account=accounts.find(x=>x.id===(attribution.aiAccountId??task?.ai_account_id));
  if(account){attribution.aiAccountId=account.id;attribution.aiAccountName=cleanName(account.name);attribution.domain=domain.safeParse(account.domain).success?account.domain:null;}
  if(context){for(const key of ['planId','planVersion','grantId','grantVersion','strategyId','strategyVersionId'])attribution[key]=context[key]??attribution[key];}
  if(task){
   attribution.taskId=task.id;attribution.taskSource=task.source;attribution.taskReadable=canReadTasks;
   if(task.source==='workbench'&&task.initiator_id){attribution.initiatorKind='human';attribution.initiatorOperatorId=task.initiator_id;attribution.initiatorDisplayName=cleanName(people.find(x=>x.operator_id===task.initiator_id)?.display_name);}
   else if(!human)attribution.initiatorKind=({routine:'schedule',event:'business-event',recovery:'recovery'})[task.source]??'unknown';
  }
  if(card&&typeof card.confirmed_at==='string'&&Number.isFinite(Date.parse(card.confirmed_at))){attribution.cardId=card.id;attribution.decisionSource='human-confirmed';attribution.decisionBasis='confirmed-operation-card';}
  if(context?.judgmentKind&&task&&calls.some(call=>call.task_id===task.id&&call.call_id===context.toolCallId&&call.operation_id===context.toolOperationId)){
   attribution.decisionSource=context.judgmentKind;attribution.decisionBasis=context.judgmentKind==='ai'?'verified-native-tool':'server-rule';
  }
  return {...row,audit_attribution:businessAuditAttributionSchema.parse(attribution)};
 });
}
