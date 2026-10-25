import {isDeepStrictEqual} from 'node:util';
import {aiActionDefinition} from '../../shared/operations-ai-action-registry.mjs';
import {automationResourceScope} from '../../shared/operations-automation-scope.mjs';

// Pre-publication checks never mint an execution actor or call a writer/model.
// They verify actual roles, grants, connected consumers and selected sources.
// An eligible scope is a predicate for future objects, not a frozen audience.
export async function previewStrategyWithin(service,db,{configuration,strategyId,actor}){
 const strategy=configuration.strategies.find(row=>row.id===strategyId),x=strategy?.execution;
 const checks=[],objects=[],grants=[];
 const check=(key,ok,detail=null)=>{checks.push({key,state:ok===true?'pass':ok===false?'fail':'unknown',detail});return ok===true;};
 if(!check('execution-configured',!!x))return{valid:false,checks,objects,grants,sideEffects:false,modelCalls:0};
 const autonomy=service.autonomy,actions=autonomy?.actionTools;
 let role=null;try{role=await autonomy?.aiWorkAccounts?.authorizationWithin(db,x.aiDomain);}catch{/* Accurate missing role, never substitute a manager. */}
 check('ai-account-enabled',role?.enabled===true);check('current-role',!!role?.permissions.length);
 check('purpose-defined',!!strategy.objective&&!!configuration.common.objective&&!!configuration.domains.find(d=>d.key===strategy.domain)?.objective);
 check('scope-resolved',x.resourceScope.kind!=='unresolved'&&(x.resourceScope.kind!=='selected'||x.resourceScope.resourceIds.length>0));
 check('trigger-configured',x.trigger.kind==='manual'||x.trigger.kind==='interval'&&Number.isSafeInteger(x.trigger.minutes)||x.trigger.kind==='daily'&&!!x.trigger.at||x.trigger.kind==='event'&&x.trigger.eventTypes.length>0);
 check('code-judgment',x.mode!=='code'||strategy.judgment!=='semantic');
 const automatic=['code','ai'].includes(x.mode),rows=(await db.query('SELECT * FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[])',[service.endpoint,x.grantIds])).rows;
 for(const code of x.actions){
  const definition=aiActionDefinition(code);check('role:'+code,role?.permissions.includes(code)===true);
  check('handler:'+code,x.mode==='code'?typeof autonomy?.codeActionReady==='function'&&autonomy.codeActionReady(code):typeof actions?.dutyActionReady==='function'&&actions.dutyActionReady(code));
  if(automatic){
   check('ordinary-action:'+code,definition?.autonomous===true&&!definition.humanOnly);
   const grant=rows.find(row=>{const scope=automationResourceScope(row);return row.enabled&&row.mode==='automatic'&&row.executor_kind===(x.mode==='code'?'program':'ai')&&(x.mode==='code'||row.ai_account_id===role?.accountId)&&row.permissions.includes(code)&&
    (scope.kind==='eligible'||scope.kind==='selected'&&x.resourceScope.kind==='selected'&&x.resourceScope.resourceIds.every(id=>scope.resourceIds.includes(id)));});
   check('grant:'+code,!!grant);if(grant&&!grants.some(row=>row.id===grant.id))grants.push({id:grant.id,version:grant.version});
  }
  if(!definition?.read)continue;
  try{await service.businessAdmin.authorizeAction(actor,definition.read,{db});check('preview-read:'+code,true);}catch{check('preview-read:'+code,false);continue;}
  if(x.resourceScope.kind!=='selected')continue;
  for(const id of x.resourceScope.resourceIds.slice(0,20)){
   try{const source=await previewObject(actions?.services,db,definition.kind,id,actor);objects.push({action:code,id,...source});check('source:'+code+':'+id,source.available);}
   catch(error){if(![403,404,409,410].includes(error?.status))throw error;objects.push({action:code,id,available:false,version:null});check('source:'+code+':'+id,false);}
  }
 }
 if(x.requiredRehearsal&&x.actions.length&&x.resourceScope.kind==='selected'){
  // Concrete-source rehearsal cannot claim semantic judgment or future
  // objects have been tested. No sample leaves this explicit requirement open.
  check('concrete-sample',objects.some(row=>row.available));
 }
 return{valid:checks.every(row=>row.state==='pass'),checks,objects,grants,aiAccountId:role?.accountId??null,authorizationVersion:role?.authorizationVersion??null,
  scope:x.resourceScope,qualification:x.resourceScope.kind==='eligible'?'checked-before-each-action':'current-selected-source',classification:'configuration-and-current-consumer',semanticJudgment:'not-validated',sideEffects:false,modelCalls:0};
}

async function first(kinds,read){for(const kind of kinds){try{return await read(kind);}catch(error){if(error?.status!==404)throw error;}}return{available:false,version:null};}
async function previewObject(services,db,kind,id,actor){
 if(['content-visibility','content-curation','public-content-batch'].includes(kind))return first(['post','reply'],async type=>{const s=services.content,r=await s.rawWithin(db,type,id),source=await s.publicSourceWithin(db,type,r.head,r.source);return{kind:type,available:source.available,version:r.source?.id??null,revision:r.head.revision??r.head.version??null};});
 if(['section-classification','section-visibility'].includes(kind)){const s=services.community,r=await s.sectionWithin(db,id);return{kind:'section',available:true,version:r.version??r.revision??null};}
 if(kind==='resource-visibility')return first(['projects','methods'],async type=>{const s=services.resources,r=await s.rowWithin(db,type,id),source=await s.sourceWithin(db,type,r);return{kind:type,available:source.state==='available',version:r.revision??null};});
 if(kind==='account-restriction'){const r=await services.accounts.accountWithin(db,id);return{kind:'account',available:true,version:r.restriction_revision};}
 if(kind==='feedback-update'){const r=await services.feedback.headWithin(db,id);return{kind:'feedback',available:true,version:r.revision};}
 if(kind==='case-resolve'){const r=await services.community.reportWithin(db,id);return{kind:'case',available:true,version:r.version??r.revision??null};}
 if(kind==='private-case-message'){
  const s=services.chatReports,row=await s.row(db,id),materials=(await db.query('SELECT event_id,message_id,revision,room_id,author_ref,source_expires_at,erased_at FROM account_chat_governance_materials_v1 WHERE report_id=$1 ORDER BY event_id,message_id',[id])).rows;
  const states=[];for(const material of materials)states.push({eventId:material.event_id,messageId:material.message_id,revision:material.revision,available:await s.sourceStillAvailableWithin(db,material)});
  return{kind:'chat-report',available:!s.expired(row)&&await s.independentWithin(db,row,actor)&&states.some(material=>material.available),version:row.version,materials:states};
 }
 if(['file-access','file-scan-retry'].includes(kind))return first(['chat','forum'],async type=>{const s=services[kind==='file-access'?'fileAccess':'files'],r=await s.scopedRowWithin(db,type,id);return{kind:type+'-file',available:!r.purged_at&&!r.revoked_at,version:r.version??r.revision??null};});
 if(kind==='messaging-state'){const r=await services.messaging.planWithin(db,id);return{kind:'message-plan',available:r.config.automation?.kind==='ordinary'&&r.config.automation?.factsConfirmed===true,version:r.version,revision:r.revision};}
 if(['search-apply','search-restore'].includes(kind)){const r=await services.searchQuality.versionWithin(db,id);return{kind:'search-quality',available:!!r,version:r?.id??null};}
 return{available:false,version:null};
}

export const unchangedPreview=(before,after)=>isDeepStrictEqual(before,after);
