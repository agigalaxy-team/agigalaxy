import {maintenanceOpeningConditions} from '../../src/operations-maintenance-catalog.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const stages=['contain','capture-current-facts','prepare','restore','reconcile','validate','activate'];
const planStates={contain:'preparing','capture-current-facts':'preparing',prepare:'preparing',restore:'restoring',reconcile:'validating',validate:'validating',activate:'opening'};
// One deliberately small, fixed restoration protocol. Every handler is server
// code registered at startup. Neither approval nor a model supplies executable
// commands, paths, predicates or arbitrary workflow steps.
export class MaintenanceRestoreExecutor{
 constructor({journal,adapters=null,now=()=>new Date()}){Object.assign(this,{journal,adapters,now});}
 capabilities(moduleIds){
  const blockers=[];
  if(!this.adapters?.version||typeof this.adapters.open!=='function')blockers.push('maintenance_production_adapter_unavailable');
  if(stages.some(stage=>typeof this.adapters?.[stage]!=='function'))blockers.push('maintenance_production_stage_not_connected');
  if(moduleIds.some(id=>!this.adapters?.moduleIds?.includes(id)))blockers.push('maintenance_production_module_not_connected');
  if(maintenanceOpeningConditions.some(id=>!this.adapters?.openingConditions?.includes(id)))blockers.push('maintenance_opening_condition_not_connected');
  return{productionExecutable:blockers.length===0,adapterVersion:this.adapters?.version??null,blockers:[...new Set(blockers)]};
 }
 async execute(intent,{point,footprint,started:provided=null,authorize=null}){
  const caps=this.capabilities(intent.moduleIds);if(!caps.productionExecutable)throw fail('maintenance_production_adapter_unavailable');
  if(footprint.digest!==intent.footprintDigest)throw fail('maintenance_plan_changed');
  const started=provided??await this.journal.begin(intent);if(!started.created)return started.row;const row=started.row;
  const context={intent,point,footprint,journalId:row.id,artifacts:null,checks:null,currentFacts:null,authority:null};
  let openingAttempted=false;
  try{
   // This durable approval copy is written before containment or data changes.
   // Restoring the business PG database cannot erase the controlling intent.
   row.approval={planId:intent.planId,revision:intent.revision,planDigest:intent.planDigest,operatorId:intent.operatorId,approvedAt:intent.approvedAt,moduleIds:intent.moduleIds,pointId:intent.pointId};await this.journal.save(row);
   for(const stage of stages){
    if(typeof authorize!=='function')throw fail('maintenance_authorization_not_connected');context.authority=await authorize();
    row.planState=planStates[stage];const step={id:stage,state:'running',startedAt:this.now().toISOString(),finishedAt:null};row.steps.push(step);await this.journal.save(row);
    if(stage==='activate'){
     // Every planned module and each approved opening condition must be ready.
     // A single healthy API or completed database restore cannot open the site.
     if(!context.checks||context.checks.prepared!==true&&(intent.moduleIds.some(id=>context.checks.modules?.[id]!==true)||maintenanceOpeningConditions.some(id=>context.checks.conditions?.[id]!==true)))throw fail('maintenance_required_modules_not_ready');
     // Staged artifacts may be ready for private activation without claiming
     // already-running services/public readiness. The final native checks below
     // remain mandatory before one public opening.
     row.planState='validating';await this.journal.save(row);
    }
    if(stage==='restore'&&context.currentFacts?.complete!==true)throw fail('maintenance_current_recovery_facts_incomplete');
    const result=await this.adapters[stage](context);
    if(stage==='prepare')context.artifacts=result;
    if(stage==='capture-current-facts')context.currentFacts=result;
    if(stage==='validate')context.checks=result;
    if(result?.accepted===false)throw fail('maintenance_restore_stage_rejected');
    step.state='succeeded';step.finishedAt=this.now().toISOString();await this.journal.save(row);
   }
   // Activation changes can themselves invalidate a readiness observation.
   // Recheck the same planned module set before the single public opening.
   const final=await this.adapters.validate(context);
   if(intent.moduleIds.some(id=>final.modules?.[id]!==true)||maintenanceOpeningConditions.some(id=>final.conditions?.[id]!==true))throw fail('maintenance_required_modules_not_ready');
   context.checks=final;row.planState='ready-to-open';await this.journal.save(row);
   const opening={id:'open',state:'running',startedAt:this.now().toISOString(),finishedAt:null};row.steps.push(opening);row.planState='opening';await this.journal.save(row);
   await authorize();openingAttempted=true;const opened=await this.adapters.open(context);if(opened?.publicActivation!==true)throw fail('maintenance_public_activation_unknown');
   opening.state='succeeded';opening.finishedAt=this.now().toISOString();row.publicActivation=true;row.planState='completed';return this.journal.finish(row);
  }catch(error){
   const step=row.steps.findLast(x=>x.state==='running');if(step){step.state='failed';step.finishedAt=this.now().toISOString();}
   row.planState='failed';row.publicActivation=openingAttempted?null:false;
   const finalError=openingAttempted?fail('maintenance_public_activation_unknown'):error;
   // No automatic rollback, restart of unrelated writers, opening or repeated
   // restore is attempted after an ambiguous or failed production stage.
   return this.journal.finish(row,finalError);
  }
 }
}
