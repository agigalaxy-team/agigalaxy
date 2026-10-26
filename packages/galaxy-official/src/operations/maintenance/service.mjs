import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {operationsQueues} from "../jobs/service.mjs";
import {hasOperationsPermission} from "../../operations-permission-catalog.mjs";
import {maintenanceActionPermissions,maintenanceModuleIds,maintenanceOpeningConditions} from "./catalog.mjs";
import {maintenanceBackupsQuerySchema,maintenancePlansQuerySchema,maintenancePageSchema,maintenanceLogsQuerySchema,maintenanceBackupCommandSchema,maintenanceCreatePlanSchema,maintenanceApprovePlanSchema,maintenanceExecutePlanSchema,maintenanceCancelPlanSchema} from "../../shared/operations-maintenance-schema.mjs";
import {maintenanceAvailability,maintenanceOverview,maintenancePolicy,maintenancePoint,maintenancePlanProjection,maintenanceCoverage,maintenanceLog,maintenanceIso} from "./view.mjs";
import {maintenanceCommandResult} from "../command-receipts.mjs";

const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const parse=(schema,input)=>{const x=schema.safeParse(input);if(!x.success)fail('invalid_maintenance_request',400);return x.data;};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pointSchema=z.string().regex(/^[a-f0-9]{64}$/);
const stamp=now=>new Date(now*1000).toISOString();
const safeNativeOperation=row=>({id:z.uuid().safeParse(row?.id).success?row.id:null,state:['pending','running','succeeded','failed','unknown'].includes(row?.state)?row.state:'unknown',kind:['backup-create','backup-verify','restore-execute'].includes(row?.kind)?row.kind:null,
 startedAt:maintenanceIso(row?.startedAt),finishedAt:maintenanceIso(row?.finishedAt),code:typeof row?.code==='string'&&/^maintenance_[a-z_]{1,80}$/.test(row.code)?row.code:null,
 planState:['preparing','restoring','validating','ready-to-open','opening','completed','failed'].includes(row?.planState)?row.planState:null,
 publicActivation:typeof row?.publicActivation==='boolean'?row.publicActivation:null,
 steps:Array.isArray(row?.steps)?row.steps.slice(0,100).map(x=>({id:typeof x.id==='string'&&/^[a-z][a-z0-9-]{0,99}$/.test(x.id)?x.id:null,state:['running','succeeded','failed','unknown','blocked'].includes(x.state)?x.state:'unknown',startedAt:maintenanceIso(x.startedAt),finishedAt:maintenanceIso(x.finishedAt)})):[]});

export class OperationsMaintenanceService{
 constructor({businessAdmin,native=null,incident=null,now=businessAdmin.now}){Object.assign(this,{businessAdmin,native,incident,db:businessAdmin.db,endpoint:businessAdmin.endpoint,now});}
 human(operator){const actor=this.businessAdmin.require(operator);if(actor.kind!=='business-operator')fail('maintenance_human_required',403);return actor;}
 async require(operator,permission,{db=this.db}={}){return this.businessAdmin.authorizeAction(this.businessAdmin.require(operator),permission,{db});}
 async capabilities(operator){
  const actor=await this.businessAdmin.revalidate(this.businessAdmin.require(operator));
  const can=permission=>hasOperationsPermission(actor,permission),human=actor.kind==='business-operator';
  return{canReadLogs:can('maintenance.logs.read'),canCreateBackup:human&&can('maintenance.backups.create'),canVerifyBackup:human&&can('maintenance.backups.verify'),canPlanRestore:human&&can('maintenance.restore.plan'),canApproveRestore:human&&can('maintenance.restore.approve'),canExecuteRestore:human&&can('maintenance.restore.execute')};
 }
 envelope(){return{checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true};}
 commandResult(operator,operationId){
  return maintenanceCommandResult({db:this.db,endpoint:this.endpoint,operator,authorize:actor=>this.require(actor,'maintenance.read'),now:this.now},operationId);
 }
 async nativeRead(command){if(!this.native)return null;try{return await this.native.call(command);}catch(error){if(error.status===409)throw error;return null;}}
 async record(db,actor,action,{operationId=null,planId=null,revision=null,kind=null,state=null,count=null}={}){
  return this.businessAdmin.recordWithin(db,actor,action,{operationId,selection:{planId,revision,kind},result:{state,count}});
 }
 async overview(operator){
  const actor=await this.require(operator,'maintenance.read');
  const source=await this.nativeRead({kind:'overview'});
  let queues={scope:'registered-business-pg-boss-queues',includesAllPlatformQueues:false,availability:maintenanceAvailability('unavailable','maintenance_queue_query_failed'),items:[]};
  try{
   const rows=(await this.db.query(`SELECT name,state,count(*)::text AS count FROM galaxy_jobs.job WHERE name=ANY($1::text[]) GROUP BY name,state`,[operationsQueues])).rows;
   const states=['created','retry','active','completed','cancelled','failed'];
   queues={...queues,availability:maintenanceAvailability('available'),items:operationsQueues.map(name=>({name,counts:Object.fromEntries(states.map(state=>[state,Number(rows.find(r=>r.name===name&&r.state===state)?.count??0)]))}))};
  }catch{/* Metadata remains partial; a database read failure is not zero jobs. */}
  await this.require(actor,'maintenance.read');
  await this.record(this.db,actor,'maintenance-query',{kind:'overview',count:source?.components?.length??null});
  const incident=this.incident?.snapshot?.();
  const mode={state:['normal','contained','recovery','resolved'].includes(incident?.state)?incident.state:'unknown',source:incident?'existing-incident-controller':'not-connected',businessWritesAccepted:typeof incident?.businessWritesAccepted==='boolean'?incident.businessWritesAccepted:null,revision:Number.isSafeInteger(incident?.revision)?incident.revision:null};
  return{...maintenanceOverview(source??{}),queues,maintenanceMode:mode,permissions:await this.capabilities(actor),...this.envelope()};
 }
 async logs(operator,input={}){
  const actor=await this.require(operator,'maintenance.logs.read'),query=parse(maintenanceLogsQuerySchema,input);
  const source=await this.nativeRead({kind:'logs',query});await this.require(actor,'maintenance.logs.read');
  const items=(source?.items??[]).map(maintenanceLog).filter(Boolean);
  await this.record(this.db,actor,'maintenance-logs-query',{kind:'logs',count:items.length});
  return{availability:maintenanceAvailability(source?'available':'unavailable',source?null:'maintenance_native_not_connected'),items,nextBefore:/^[0-9]{16,20}$/.test(source?.nextBefore??'')?source.nextBefore:null,pageBasis:'native-loki-time-range',components:Array.isArray(source?.components)?source.components.filter(x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x)):[],query,...this.envelope()};
 }
 async backups(operator,input={}){
  const actor=await this.require(operator,'maintenance.read'),query=parse(maintenanceBackupsQuerySchema,input),source=await this.nativeRead({kind:'catalog',query});
  await this.require(actor,'maintenance.read');
  const items=(source?.items??[]).map(maintenancePoint).filter(Boolean),caps=await this.capabilities(actor);
  await this.record(this.db,actor,'maintenance-query',{kind:'backups',count:items.length});
  return{availability:maintenanceAvailability(source?'available':'unavailable',source?null:'maintenance_native_not_connected'),policy:maintenancePolicy(source?.policy),currentCoverage:maintenanceCoverage(source?.coverage),
   items,total:Number.isSafeInteger(source?.total)&&source.total>=0?source.total:null,nextAfter:pointSchema.safeParse(source?.nextAfter).success?source.nextAfter:null,
   permissions:{...caps,canCreateBackup:caps.canCreateBackup&&source?.capabilities?.backupCreate===true,canVerifyBackup:caps.canVerifyBackup&&source?.capabilities?.backupVerify===true},...this.envelope()};
 }
 async backup(operator,id){
  const actor=await this.require(operator,'maintenance.read');parse(pointSchema,id);const source=await this.nativeRead({kind:'point',pointId:id});
  await this.require(actor,'maintenance.read');const point=maintenancePoint(source?.point);if(!point)fail(source?'maintenance_backup_not_found':'maintenance_native_unavailable',source?404:503);
  await this.record(this.db,actor,'maintenance-query',{kind:'backup'});return{point,...this.envelope()};
 }
 async command(operator,action,input,{authorize},fn){
  const initial=this.human(operator);if(typeof authorize!=='function')fail('maintenance_authorization_unavailable',503);
  const current=async db=>{const fresh=await authorize();if(fresh?.operatorId!==initial.operatorId||fresh?.endpoint!==initial.endpoint)fail('business_admin_denied',403);return this.require(fresh,maintenanceActionPermissions[action],{db});};
  // The HTTP closure authenticates session/CSRF. The function grant is checked
  // on this transaction, avoiding a second connection waiting on its own lock.
  return transaction(this.db,async db=>{
   const actor=await current(db);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912419))',[this.endpoint+':maintenance:'+input.operationId]);
   const old=(await db.query('SELECT * FROM operations_maintenance_events_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,input.operationId])).rows[0];
   const kind=action.slice('maintenance-'.length);
   if(old){if(old.operator_id!==actor.operatorId||old.action!==kind||!isDeepStrictEqual(old.input,input))fail('maintenance_operation_conflict');await current(db);return{...old.result,replayed:true};}
   const result={...await fn(db,actor,current),operationId:input.operationId,recordedAt:stamp(this.now())};
   await current(db);
   await db.query(`INSERT INTO operations_maintenance_events_v1(id,endpoint,operation_id,operator_id,operator_role,action,plan_id,revision,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(),this.endpoint,input.operationId,actor.operatorId,actor.role,kind,result.planId??null,result.revision??null,JSON.stringify(input),JSON.stringify(result),stamp(this.now())]);
   await this.record(db,actor,action,{operationId:input.operationId,planId:result.planId??null,revision:result.revision??null,kind,state:result.state??null});
   return result;
  });
 }
 async runBackup(operator,input,options={}){
  const x=parse(maintenanceBackupCommandSchema,input),action=x.kind==='create'?'maintenance-backup-create':'maintenance-backup-verify';
  if(!this.native)fail('maintenance_native_not_configured',503);
  const receipt=await this.command(operator,action,x,options,async()=>({state:'accepted'}));
  // The committed intent must exist before the native worker can ask for
  // current authority. A lost ACK reuses this same operation, never a new one.
  const fresh=await options.authorize();await this.require(fresh,maintenanceActionPermissions[action]);
  if(fresh.operatorId!==operator.operatorId||fresh.endpoint!==this.endpoint)fail('business_admin_denied',403);
  const operation=await this.native.call({kind:x.kind==='create'?'backup-create':'backup-verify',operationId:x.operationId,operatorId:fresh.operatorId,...(x.pointId?{pointId:x.pointId}:{})});
  return{...receipt,operation:safeNativeOperation(operation)};
 }
 async rowWithin(db,id,{lock=false}={}){
  parse(z.uuid(),id);const row=(await db.query('SELECT * FROM operations_maintenance_plans_v1 WHERE endpoint=$1 AND id=$2'+(lock?' FOR UPDATE':''),[this.endpoint,id])).rows[0];
  if(!row)fail('maintenance_plan_not_found',404);return row;
 }
 async plans(operator,input={}){
  const actor=await this.require(operator,'maintenance.read'),query=parse(maintenancePlansQuerySchema,input);let anchor=null;
  if(query.after)anchor=await this.rowWithin(this.db,query.after);
  const rows=(await this.db.query(`SELECT * FROM operations_maintenance_plans_v1 WHERE endpoint=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,[this.endpoint,anchor?.created_at??null,anchor?.id??null,query.limit+1])).rows;
  await this.require(actor,'maintenance.read');return{items:rows.slice(0,query.limit).map(maintenancePlanProjection),nextAfter:rows.length>query.limit?rows[query.limit-1].id:null,...this.envelope()};
 }
 async plan(operator,id,input={}){
  const actor=await this.require(operator,'maintenance.read'),query=parse(maintenancePageSchema,input),row=await this.rowWithin(this.db,id);
  const rows=(await this.db.query('SELECT sequence,operator_id,action,revision,result,created_at FROM operations_maintenance_events_v1 WHERE endpoint=$1 AND plan_id=$2 AND ($3::bigint IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT $4',[this.endpoint,id,query.after??null,query.limit+1])).rows;
  const nativeOperation=row.execution_id?await this.nativeRead({kind:'operation',operationId:row.execution_id}):null;
  await this.require(actor,'maintenance.read');const caps=await this.capabilities(actor),plan=maintenancePlanProjection(row),operation=nativeOperation?safeNativeOperation(nativeOperation):null;
  // Native execution is the independent control journal; it is not rolled
  // back along with the business database being restored.
   if(operation?.planState)plan.state=operation.planState;
   if(operation)plan.productionActivation=operation.publicActivation===true?'recorded-by-approved-executor':operation.publicActivation===false?'not-opened':'unknown';
  return{plan,operation,history:{items:rows.slice(0,query.limit).map(x=>({sequence:String(x.sequence),operatorId:x.operator_id,action:x.action,revision:x.revision,state:x.result?.state??null,createdAt:maintenanceIso(x.created_at)})),nextAfter:rows.length>query.limit?String(rows[query.limit-1].sequence):null},
   permissions:{canApprove:caps.canApproveRestore&&row.state==='awaiting-approval',canExecute:caps.canExecuteRestore&&row.state==='approved',canCancel:caps.canPlanRestore&&['blocked','awaiting-approval','approved'].includes(row.state)},...this.envelope()};
 }
 async createPlan(operator,input,options={}){
  const x=parse(maintenanceCreatePlanSchema,input);return this.command(operator,'maintenance-restore-plan',x,options,async(db,actor)=>{
   if(!this.native)fail('maintenance_native_not_configured',503);
   const selected=x.scope==='whole-site'?[...maintenanceModuleIds]:x.moduleIds;
   const preview=await this.native.call({kind:'restore-preview',pointId:x.pointId,moduleIds:selected});
   const point=maintenancePoint(preview.point);if(!point)fail('maintenance_backup_not_found',404);
   const moduleIds=Array.isArray(preview.moduleIds)?maintenanceModuleIds.filter(id=>preview.moduleIds.includes(id)):selected;
   if(selected.some(id=>!moduleIds.includes(id)))fail('maintenance_native_response_invalid',503);
   const modules=maintenanceCoverage(point.coverage).filter(x=>moduleIds.includes(x.id)),blockers=new Set((preview.blockers??[]).filter(v=>typeof v==='string'&&/^maintenance_[a-z_]{1,80}$/.test(v)));
   if(modules.some(x=>x.state!=='covered'))blockers.add('maintenance_point_coverage_incomplete');
   if(point.integrity.state!=='verified')blockers.add('maintenance_point_not_verified');
   if(preview.productionExecutable!==true)blockers.add('maintenance_production_adapter_unavailable');
   if(!/^[a-f0-9]{64}$/.test(preview.footprintDigest??''))blockers.add('maintenance_current_footprint_unknown');
   const from=point.capture.startedAt??point.createdAt,at=stamp(this.now()),loss=from?Math.max(0,Math.ceil((Date.parse(at)-Date.parse(from))/1000)):null;
    const plan={version:1,scope:x.scope,point,moduleIds,modules,footprintDigest:preview.footprintDigest??null,adapterVersion:preview.adapterVersion??null,
     preservedCurrent:{state:'declared',items:['accounts','passwords','current-permissions','keys'],basis:'current-security-authority'},
    possibleLoss:{from,to:at,observedWindowSeconds:loss,maximumSeconds:null,through:'related-writer-pause',basis:from?'point-to-plan-time':'unknown'},
    openingConditions:maintenanceOpeningConditions.map(id=>({id,state:'required'})),blockers:[...blockers].sort((a,b)=>a<b?-1:a>b?1:0)};
   const id=randomUUID(),state=blockers.size?'blocked':'awaiting-approval',hash=digest(plan);
   await db.query(`INSERT INTO operations_maintenance_plans_v1(id,endpoint,revision,point_id,state,plan,plan_digest,created_by,created_at,updated_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$8)`,[id,this.endpoint,x.pointId,state,JSON.stringify(plan),hash,actor.operatorId,at]);
   return{planId:id,revision:1,state,planDigest:hash};
  });
 }
 async approvePlan(operator,id,input,options={}){
  parse(z.uuid(),id);const x=parse(maintenanceApprovePlanSchema,input);return this.command(operator,'maintenance-restore-approve',{...x,planId:id},options,async(db,actor)=>{
   const row=await this.rowWithin(db,id,{lock:true});if(row.revision!==x.expectedRevision||row.plan_digest!==x.expectedPlanDigest)fail('maintenance_plan_changed');
   if(row.state!=='awaiting-approval'||row.plan.blockers.length)fail('maintenance_plan_not_approvable');
   await this.recheckPlan(row);
   const revision=row.revision+1;await db.query(`UPDATE operations_maintenance_plans_v1 SET state='approved',revision=$3,approved_by=$4,approved_at=$5,approved_revision=$3,updated_at=$5 WHERE endpoint=$1 AND id=$2`,[this.endpoint,id,revision,actor.operatorId,stamp(this.now())]);
   return{planId:id,revision,state:'approved'};
  });
 }
 async recheckPlan(row){
   if(!isDeepStrictEqual(row.plan.preservedCurrent,{state:'declared',items:['accounts','passwords','current-permissions','keys'],basis:'current-security-authority'}))fail('maintenance_security_preservation_not_recorded');
  if(!this.native)fail('maintenance_native_not_configured',503);const x=await this.native.call({kind:'restore-preview',pointId:row.point_id,moduleIds:row.plan.moduleIds});
  if(x.productionExecutable!==true||x.footprintDigest!==row.plan.footprintDigest||x.adapterVersion!==row.plan.adapterVersion||x.blockers?.length||maintenancePoint(x.point)?.integrity.state!=='verified')fail('maintenance_plan_changed');
 }
 async executePlan(operator,id,input,options={}){
  parse(z.uuid(),id);const x=parse(maintenanceExecutePlanSchema,input);const receipt=await this.command(operator,'maintenance-restore-execute',{...x,planId:id},options,async(db,actor,current)=>{
   const row=await this.rowWithin(db,id,{lock:true});if(row.revision!==x.expectedRevision||row.approved_revision!==row.revision||row.state!=='approved')fail('maintenance_plan_changed');
   await this.recheckPlan(row);await current(db);
   const revision=row.revision+1;await db.query(`UPDATE operations_maintenance_plans_v1 SET state='preparing',revision=$3,execution_id=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2`,[this.endpoint,id,revision,x.operationId,stamp(this.now())]);
   return{planId:id,revision,state:'preparing'};
  });
  const fresh=await options.authorize();await this.require(fresh,'maintenance.restore.execute');
  if(fresh.operatorId!==operator.operatorId||fresh.endpoint!==this.endpoint)fail('business_admin_denied',403);
  const row=await this.rowWithin(this.db,id);
  const operation=await this.native.call({kind:'restore-execute',operationId:x.operationId,operatorId:fresh.operatorId,planId:id,revision:row.approved_revision,planDigest:row.plan_digest,approvedAt:maintenanceIso(row.approved_at),pointId:row.point_id,moduleIds:row.plan.moduleIds,openingConditions:[...maintenanceOpeningConditions],footprintDigest:row.plan.footprintDigest});
  return{...receipt,operation:safeNativeOperation(operation)};
 }
 async operation(operator,id){
  const actor=await this.require(operator,'maintenance.read');parse(z.uuid(),id);
  const row=(await this.db.query('SELECT operator_id,action,plan_id FROM operations_maintenance_events_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,id])).rows[0];if(!row)fail('maintenance_operation_not_found',404);
  const operation=await this.nativeRead({kind:'operation',operationId:id});await this.require(actor,'maintenance.read');
  return{operation:operation?safeNativeOperation(operation):null,availability:maintenanceAvailability(operation?'available':'unavailable',operation?null:'maintenance_native_not_connected'),...this.envelope()};
 }
 async authorizeNative(input){
  // Only the private HTTP adapter calls this method after service-key/HMAC
  // verification. It never accepts a role or a grant list from the agent.
  const x=parse(z.strictObject({operationId:z.uuid(),operatorId:z.string().min(1).max(500),kind:z.enum(['backup-create','backup-verify','restore-execute']),planId:z.uuid().optional(),revision:z.number().int().positive().optional(),planDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),
   pointId:pointSchema.optional(),moduleIds:z.array(z.enum(maintenanceModuleIds)).optional(),footprintDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),openingConditions:z.array(z.enum(maintenanceOpeningConditions)).optional(),approvedAt:z.iso.datetime({offset:true}).optional()}),input);
  return transaction(this.db,async db=>{
   const row=(await db.query('SELECT * FROM operations_maintenance_events_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,x.operationId])).rows[0];
   if(!row||row.operator_id!==x.operatorId||row.action!==x.kind)fail('maintenance_execution_not_authorized',403);
   const actor=await this.businessAdmin.revalidate({kind:'business-operator',operatorId:row.operator_id,role:row.operator_role,endpoint:this.endpoint},{action:maintenanceActionPermissions['maintenance-'+x.kind],db});
   if(x.kind==='backup-verify'&&x.pointId!==row.input.pointId)fail('maintenance_execution_not_authorized',403);
   if(x.kind==='restore-execute'){
    const plan=await this.rowWithin(db,row.plan_id);
    if(x.planId!==plan.id||x.revision!==plan.approved_revision||x.planDigest!==plan.plan_digest||plan.execution_id!==x.operationId||!plan.approved_by||!['preparing','restoring','validating','ready-to-open','opening'].includes(plan.state)
     ||x.pointId!==plan.point_id||x.footprintDigest!==plan.plan.footprintDigest||!isDeepStrictEqual(x.moduleIds,plan.plan.moduleIds)||!isDeepStrictEqual(x.openingConditions,maintenanceOpeningConditions)||x.approvedAt!==maintenanceIso(plan.approved_at))fail('maintenance_execution_not_authorized',403);
   }
   return{authorized:true,operationId:x.operationId,operatorId:actor.operatorId,kind:x.kind,endpoint:this.endpoint};
  });
 }
 async cancelPlan(operator,id,input,options={}){
  parse(z.uuid(),id);const x=parse(maintenanceCancelPlanSchema,input);return this.command(operator,'maintenance-restore-cancel',{...x,planId:id},options,async(db)=>{
   const row=await this.rowWithin(db,id,{lock:true});if(row.revision!==x.expectedRevision||!['blocked','awaiting-approval','approved'].includes(row.state))fail('maintenance_plan_changed');
   const revision=row.revision+1;await db.query(`UPDATE operations_maintenance_plans_v1 SET state='cancelled',revision=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2`,[this.endpoint,id,revision,stamp(this.now())]);return{planId:id,revision,state:'cancelled'};
  });
 }
}
