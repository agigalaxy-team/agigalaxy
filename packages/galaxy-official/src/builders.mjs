import { builderEventSchema,builderReadSchema,builderQuerySchema,builderAssessorIdsSchema,conformanceChecks,builderSearchFields } from './shared/builders-schema.mjs';
import { builderOwnedQuerySchema,builderReceiptSchema,builderNoticesSchema,builderRecoveryActions } from './shared/builders-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { transaction } from './database.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
import { conformanceRequestSchema, conformanceSuitePinsSchema, conformanceSnapshotSchema, suiteValidity, reportCoverage } from './shared/conformance-schema.mjs';
import { nodeControlRequestSchema,nodeControlSnapshotSchema } from './shared/node-control-proof-schema.mjs';
import { readBuilderWorkSources,readBuilderWorkEvidence } from './domain/builder-work-evidence.mjs';
import { readBuilderProbe } from './domain/builder-probe-source.mjs';
import { builderProbeTarget } from './builder-probe-observer.mjs';
import { randomUUID } from 'node:crypto';

export class BuilderService {
  constructor(access,consents,proofs,assessorIds=[],{suitePins=[],sign}={}) {
    Object.assign(this,{access,consents,proofs}); this.assessorIds=new Set(builderAssessorIdsSchema.parse(assessorIds));
    this.suitePins=conformanceSuitePinsSchema.parse(suitePins); this.signConformance=sign;
  }
  specification() { return {version:'0.1',types:['worker','bridge','hub'],checks:conformanceChecks,
    compatibilityAuthority:'configured-assessor-reported; exact declaration and suite digest',
    workEvidence:{supported:true,authority:'node-signed-source-association',requiredSources:['case','attempt','result','ci-proof'],maxProofReferences:8,
      currentSourcesChecked:true,executionAttributionVerified:false,taskReferenceAuthority:'node-declared'},
    automaticEndpointProbes:false,reachabilityProbeMode:'explicit-node-request; A2A 1.0 JSONRPC read only',workerExecution:false,hubConnection:false,capabilityVerified:false}; }
  grant(db,row) { return this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,objectId:row.id,
    action:'builder.publish',recipient:this.access.endpoint,payloadJson:row.payload_text}); }
  visible(grant,actor) { return canReadProjection(grant,{viewerId:actor?.subjectId??null,now:this.access.now()}); }
  async load(db,builderId,lock='SHARE') {
    const parent=(await db.query(`SELECT * FROM builders WHERE id=$1 FOR ${lock}`,[builderId])).rows[0];
    if(!parent)throw new ServiceError('builder_unavailable',404);
    const rows=(await db.query('SELECT * FROM builder_events WHERE builder_id=$1 ORDER BY revision',[builderId])).rows;
    const declaration=rows.findLast(row=>row.kind==='declare');
    return {parent,rows,declaration};
  }
  async current(db,actor,loaded) {
    const row=loaded.declaration;
    // A revoked or private replacement must never resurrect an obsolete public declaration.
    if(!row)throw new ServiceError('builder_unavailable',404);
    const grant=await this.grant(db,row);
    if(!this.visible(grant,actor))throw new ServiceError('builder_unavailable',404);
    return {row,grant,payload:JSON.parse(row.payload_text).declaration};
  }
  async proofReferences(db,actor,ownerId,ids,required=false) {
    const items=[];
    for(const id of ids)try {
      const row=(await db.query('SELECT subject_id FROM proofs WHERE id=$1',[id])).rows[0];
      if(row?.subject_id!==ownerId)throw new ServiceError('builder_proof_owner_mismatch',409);
      await this.proofs.readWithin(db,actor,id);
      items.push({proofId:id,state:'current',relationship:'owner-ci-observation',builderAttributionVerified:false});
    }catch(error){if(!(error instanceof ServiceError))throw error;if(required)throw error;
      items.push({proofId:id,state:'unavailable',builderAttributionVerified:false});}
    return items;
  }
  async publish(actor,{consentId,payloadJson}) {
    let payload;try{if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>28000)throw new Error();
      payload=builderEventSchema.parse(JSON.parse(payloadJson));}catch{throw new ServiceError('invalid_builder_payload');}
    return this.access.runResourceWrite(actor,'builders',{control:['node-control-revoke','work-evidence-revoke'].includes(payload.kind)||payload.kind==='maintenance'&&['delist','security-issue'].includes(payload.action)},async(db,authorization)=>{
      if(payload.kind==='declare'&&payload.expectedRevision===0)
        await db.query('INSERT INTO builders(id,owner_id,type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[payload.builderId,actor.subjectId,payload.declaration.type]);
      const loaded=await this.load(db,payload.builderId,'UPDATE'),{parent,rows}=loaded;
      const assessor=payload.kind==='compatibility';
      const nodeAction=['node-control','node-control-revoke','work-evidence','work-evidence-revoke','probe-request'].includes(payload.kind);
      if(!nodeAction&&(assessor ? !this.assessorIds.has(actor.subjectId)||actor.subjectId===parent.owner_id : actor.subjectId!==parent.owner_id))
        throw new ServiceError(assessor?'builder_assessor_required':'builder_owner_required',403);
      const grant=await this.grant(db,{id:payload.id,subject_id:actor.subjectId,consent_id:consentId,payload_text:payloadJson});
      if(!['Private','Public'].includes(grant.visibility))throw new ServiceError('builder_visibility_required',403);
      const prior=(await db.query('SELECT * FROM builder_events WHERE id=$1',[payload.id])).rows[0];
      if(prior){if(prior.builder_id!==parent.id||prior.subject_id!==actor.subjectId||prior.consent_id!==consentId||prior.payload_hash!==digest(payloadJson))throw new ServiceError('builder_event_conflict',409);
        return {builderId:parent.id,eventId:prior.id,revision:prior.revision};}
      if(parent.revision!==payload.expectedRevision||parent.revision>=1000)throw new ServiceError('builder_revision_conflict',409);
      if(payload.kind==='declare'){
        if(payload.declaration.type!==parent.type)throw new ServiceError('builder_type_immutable',409);
        await this.proofReferences(db,actor,parent.owner_id,payload.declaration.proofIds,true);
      }else{
        let current;
        try{current=await this.current(db,actor,loaded);}catch(error){
          if(!(error instanceof ServiceError)||actor.subjectId!==parent.owner_id||payload.kind!=='maintenance'||!builderRecoveryActions.includes(payload.action)||!loaded.declaration)throw error;
          // A new exact Consent authorizes only this control notice. It cannot
          // republish an expired/revoked declaration or make it visible again.
          current={row:loaded.declaration,grant:null};
        }
        if(payload.declarationId!==current.row.id)throw new ServiceError('builder_declaration_changed',409);
        if(nodeAction && (current.payload.type!=='worker'||(['node-control','work-evidence','probe-request'].includes(payload.kind)
          ? actor.subjectId!==current.payload.nodeId : ![parent.owner_id,current.payload.nodeId].includes(actor.subjectId))))
          throw new ServiceError('builder_node_holder_required',403);
        if(current.grant&&(grant.visibility!==current.grant.visibility || (assessor || nodeAction && actor.subjectId!==parent.owner_id
          ? grant.visibility==='Private' && (!grant.viewers.includes(parent.owner_id)||grant.viewers.some(id=>id!==parent.owner_id&&!current.grant.viewers.includes(id)))
          : JSON.stringify([...grant.viewers].sort((a,b)=>a.localeCompare(b)))!==JSON.stringify([...current.grant.viewers].sort((a,b)=>a.localeCompare(b))))))
          throw new ServiceError('builder_visibility_mismatch',403);
        if(assessor && (payload.declarationHash!==current.row.payload_hash||payload.observedAt>this.access.now()
          ||payload.observedAt<this.access.now()-2592000||payload.expiresAt<=this.access.now()
          ||payload.expiresAt<=payload.observedAt||payload.expiresAt-payload.observedAt>2592000))throw new ServiceError('builder_report_mismatch',409);
        if(payload.kind==='node-control' && (payload.declarationHash!==current.row.payload_hash || payload.ownerId!==parent.owner_id
          ||payload.nodeId!==current.payload.nodeId||payload.expiresAt<=this.access.now()||payload.expiresAt>grant.expiresAt))
          throw new ServiceError('builder_node_control_mismatch',409);
        if(payload.kind==='node-control-revoke'){
          const priorControl=rows.findLast(row=>row.kind==='node-control'&&JSON.parse(row.payload_text).declarationId===current.row.id);
          if(!priorControl||priorControl.id!==payload.controlId||rows.some(row=>row.kind==='node-control-revoke'&&JSON.parse(row.payload_text).controlId===payload.controlId))
            throw new ServiceError('builder_node_control_unavailable',409);
        }
        if(['work-evidence','probe-request'].includes(payload.kind)){
          const control=await this.nodeControl(db,actor,loaded,current);
          if(control.state!=='node-authorized-owner'||payload.controlId!==control.controlId||payload.nodeId!==actor.subjectId||payload.declarationHash!==current.row.payload_hash)
            throw new ServiceError('builder_work_node_authorization_required',409);
          if(payload.kind==='work-evidence'){
            await readBuilderWorkSources(this,db,actor,payload);
            if(grant.visibility==='Public')await readBuilderWorkSources(this,db,null,payload);
          }else{
            try{if(JSON.stringify(builderProbeTarget(current.payload.a2a))!==JSON.stringify(builderProbeTarget(payload.target)))throw new Error();}
            catch{throw new ServiceError('builder_probe_target_required',409);}
            const state=this.maintenance(rows),last=rows.findLast(row=>row.kind==='probe-request');
            if(state.delisted||state.securityIssue)throw new ServiceError('builder_probe_maintenance_blocked',409);
            if(last&&this.access.now()-Number(last.received_at)<60)throw new ServiceError('builder_probe_cooldown',429);
          }
        }
        if(payload.kind==='work-evidence-revoke'){
          const work=rows.find(row=>row.id===payload.workEventId&&row.kind==='work-evidence');
          if(!work||rows.some(row=>row.kind==='work-evidence-revoke'&&JSON.parse(row.payload_text).workEventId===work.id))throw new ServiceError('builder_work_revoke_unavailable',409);
        }
        if(payload.kind==='maintenance'){
          const state=this.maintenance(rows);
          if(payload.action==='delist'&&state.delisted||payload.action==='relist'&&!state.delisted
            ||payload.action==='security-issue'&&state.securityIssue||payload.action==='resolve-security'&&!state.securityIssue)
            throw new ServiceError('builder_transition_denied',409);
        }
      }
      const revision=parent.revision+1,receivedAt=this.access.now();
      await db.query('INSERT INTO builder_events(id,builder_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [payload.id,parent.id,actor.subjectId,revision,payload.kind,consentId,payloadJson,digest(payloadJson),receivedAt]);
      await db.query('UPDATE builders SET revision=$2 WHERE id=$1',[parent.id,revision]);
      if(payload.kind==='probe-request')await db.query("INSERT INTO jobs(id,kind,deduplication_key,payload,available_at) VALUES($1,'builder-probe',$2,$3,$4)",
        [randomUUID(),'builder-probe:'+payload.id,JSON.stringify({builderId:parent.id,requestId:payload.id,subjectId:actor.subjectId,
          origins:[...new Set([new URL(payload.target.endpoint).origin,new URL(payload.target.cardUrl).origin])]}),new Date(receivedAt*1000).toISOString()]);
      await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:payload.id,action:'builder.event',httpRequestId:actor.httpRequestId??null,...authorization});
      return {builderId:parent.id,eventId:payload.id,revision};
    });
  }
  maintenance(rows){let delisted=false,securityIssue=false;
    for(const row of rows)if(row.kind==='maintenance'){
      const {action}=JSON.parse(row.payload_text);
      if(action==='delist')delisted=true;if(action==='relist')delisted=false;
      if(action==='security-issue')securityIssue=true;if(action==='resolve-security')securityIssue=false;
    }
    return {delisted,securityIssue};
  }
  async managementWithin(db,actor,builderId){
    const loaded=await this.load(db,builderId),{parent,declaration,rows}=loaded;
    if(parent.owner_id!==actor.subjectId)throw new ServiceError('builder_unavailable',404);
    let current=null;try{current=await this.current(db,actor,loaded);}catch(error){if(!(error instanceof ServiceError))throw error;}
    return {mode:'owner-management',builderId,ownerId:parent.owner_id,type:parent.type,revision:parent.revision,
      declarationId:declaration?.id??null,declarationHash:declaration?.payload_hash??null,declaration:current?.payload??null,
      declarationState:current?'readable':'unavailable',...this.maintenance(rows),capabilityVerified:false,
      allowedActions:current?['declare','delist','relist','correction','security-issue','resolve-security']:['declare',...builderRecoveryActions],
      ...(current?{disclosure:{visibility:current.grant.visibility,viewers:current.grant.viewers}}:{})};
  }
  manage(actor,input){const parsed=builderReadSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');
    return this.access.runAuthorized(actor,'builders',db=>this.managementWithin(db,actor,parsed.data.builderId));}
  owned(actor,input={}){const parsed=builderOwnedQuerySchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');
    return this.access.runAuthorized(actor,'builders',async db=>{
      const query=parsed.data,rows=(await db.query('SELECT id FROM builders WHERE owner_id=$1 AND ($2::text IS NULL OR type=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',
        [actor.subjectId,query.type??null,query.after??null,query.limit+1])).rows,items=[];
      for(const row of rows.slice(0,query.limit)){const item=await this.managementWithin(db,actor,row.id);items.push({builderId:item.builderId,type:item.type,revision:item.revision,
        name:item.declaration?.name??null,declarationState:item.declarationState,delisted:item.delisted,securityIssue:item.securityIssue});}
      return {items,nextAfter:rows.length>query.limit?items.at(-1).builderId:null,scope:'current-owner',automaticEndpointProbes:false};
    });
  }
  receipt(actor,input){const parsed=builderReceiptSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');
    return this.access.runAuthorized(actor,'builders',async db=>{
      const query=parsed.data,row=(await db.query('SELECT builder_id,subject_id,consent_id,payload_hash,revision FROM builder_events WHERE id=$1',[query.eventId])).rows[0];
      if(row&&row.subject_id!==actor.subjectId)throw new ServiceError('builder_unavailable',404);
      return {builderId:query.builderId,eventId:query.eventId,payloadHash:query.payloadHash,checkedAt:this.access.now(),
        state:!row?'absent':row.builder_id!==query.builderId||row.payload_hash!==query.payloadHash?'conflict':'acknowledged',
        ...(row&&row.builder_id===query.builderId&&row.payload_hash===query.payloadHash?{consentId:row.consent_id,revision:row.revision}:{}),
        authority:'accepted-event-only; no current disclosure or capability conclusion'};
    });
  }
  notices(actor,input){const parsed=builderNoticesSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');
    const read=async db=>{
      const query=parsed.data,loaded=await this.load(db,query.builderId),items=[];
      for(const row of loaded.rows){if(row.kind!=='maintenance'||row.revision<=query.after)continue;
        try{if(!this.visible(await this.grant(db,row),actor))continue;
          const event=JSON.parse(row.payload_text);items.push({eventId:row.id,declarationId:event.declarationId,revision:row.revision,action:event.action,summary:event.summary,receivedAt:Number(row.received_at)});
          if(items.length>query.limit)break;
        }catch(error){if(!(error instanceof ServiceError))throw error;}}
      if(!items.length&&actor?.subjectId!==loaded.parent.owner_id)await this.current(db,actor,loaded);
      const page=items.slice(0,query.limit);return {builderId:query.builderId,items:page,nextAfter:items.length>query.limit?page.at(-1).revision:null,
        scope:'currently-visible-maintenance-history',declarationIncluded:false,capabilityVerified:false};
    };
    return actor?this.access.runAuthorized(actor,'builders',read):transaction(this.access.db,read);
  }
  async nodeControl(db,actor,loaded,current){
    const base={state:current.payload.type==='worker'?'unverified':'not-applicable',capabilityVerified:false,endpointControlVerified:false};
    if(current.payload.type!=='worker')return base;
    const control=loaded.rows.findLast(row=>row.kind==='node-control'&&JSON.parse(row.payload_text).declarationId===current.row.id);
    if(!control)return base;
    const revoked=loaded.rows.some(row=>row.kind==='node-control-revoke'&&JSON.parse(row.payload_text).controlId===control.id);
    if(revoked)return {...base,state:'revoked'};
    try{
      if(!this.visible(await this.grant(db,control),actor))return base;
      const payload=JSON.parse(control.payload_text);
      return {...base,state:payload.expiresAt<=this.access.now()?'expired':'node-authorized-owner',controlId:control.id,
        nodeId:payload.nodeId,ownerId:payload.ownerId,expiresAt:payload.expiresAt,
        authority:'Node Galaxy key holder approved this owner and exact declaration through signed Consent; no private key transfer'};
    }catch(error){if(!(error instanceof ServiceError))throw error;return {...base,state:'unavailable'};}
  }
  async readWithin(db,actor,input){
    const loaded=await this.load(db,input.builderId),{parent,rows}=loaded,current=await this.current(db,actor,loaded);
    const state=this.maintenance(rows),notices=[],reports=[],versions=[];let lastHeartbeat=null;
    // The newest report per assessor supersedes their older report even when revoked.
    const latestReports=new Map();
    for(const row of rows)if(row.kind==='compatibility'&&JSON.parse(row.payload_text).declarationId===current.row.id)latestReports.set(row.subject_id,row.id);
    for(const row of rows){try{
      if(!this.visible(await this.grant(db,row),actor))continue;
      const event=JSON.parse(row.payload_text);
      if(row.kind==='declare')versions.push({declarationId:row.id,revision:row.revision,name:event.declaration.name,version:event.declaration.release.version});
      if(row.kind==='maintenance')notices.push({eventId:row.id,revision:row.revision,...event});
      if(row.kind==='heartbeat'&&event.declarationId===current.row.id)lastHeartbeat={receivedAt:Number(row.received_at),eventId:row.id};
      if(row.kind==='compatibility'){
        const suiteStatus=suiteValidity(event.suite,this.suitePins,this.access.now(),event.observedAt);
        const validity=event.declarationId!==current.row.id?'stale-declaration':!this.assessorIds.has(row.subject_id)?'assessor-removed'
          :latestReports.get(row.subject_id)!==row.id?'superseded':event.expiresAt<=this.access.now()?'expired'
          :!['current','untracked'].includes(suiteStatus.state)?`suite-${suiteStatus.state}`:'current';
        reports.push({...event,assessorId:row.subject_id,validity,suiteStatus,coverage:reportCoverage(event),authority:'configured-assessor-reported'});
      }
    }catch(error){if(!(error instanceof ServiceError))throw error;}}
    const active=reports.filter(report=>report.validity==='current');
    const compatibility=active.some(report=>report.checks.some(check=>check.status==='fail'))?'reported-fail'
      :active.some(report=>report.checks.every(check=>check.status==='pass'))?'reported-pass':active.length?'incomplete':'unverified';
    const proofReferences=await this.proofReferences(db,actor,parent.owner_id,current.payload.proofIds);
    const nodeControl=await this.nodeControl(db,actor,loaded,current);
    const nodeWorkEvidence=await readBuilderWorkEvidence(this,db,actor,loaded,current,nodeControl);
    const reachability=await readBuilderProbe(this,db,actor,loaded,current,{state:lastHeartbeat&&this.access.now()-lastHeartbeat.receivedAt<=900?'recent-owner-heartbeat':'unknown',
      ...lastHeartbeat,endpointProbed:false,endpointReachable:null,capabilityVerified:false});
    return {builderId:parent.id,ownerId:parent.owner_id,type:parent.type,revision:parent.revision,declarationId:current.row.id,
      declarationHash:current.row.payload_hash,declaration:current.payload,versions,notices,reports,
      registration:{state:state.delisted?'delisted':'registered',control:'authenticated registry owner; Node approval is separate; endpoint control not established'},nodeControl,
      compatibility:{state:compatibility,fullScopeState:active.some(report=>report.checks.some(check=>check.status==='fail'))?'reported-fail'
        :active.some(report=>report.coverage.complete&&report.checks.every(check=>check.status==='pass'))?'reported-pass':active.length?'incomplete':'unverified',
        blockedByMaintenance:state.delisted||state.securityIssue,capabilityVerified:false},
      reachability,
      evidence:{state:nodeWorkEvidence.currentCount?'node-attested-ci-evidence':proofReferences.some(item=>item.state==='current')?'owner-ci-evidence':'none-current',items:proofReferences,nodeWorkEvidence,builderAttributionVerified:false},
      ...state,capabilityVerified:false,checkedAt:this.access.now(),
      ...(actor?.subjectId===parent.owner_id?{disclosure:{visibility:current.grant.visibility,viewers:current.grant.viewers}}:{}),
      ...(current.payload.type==='worker'&&actor?.subjectId===current.payload.nodeId?{nodeControlDisclosure:{visibility:current.grant.visibility,
        viewers:actor.subjectId===parent.owner_id?current.grant.viewers:current.grant.visibility==='Public'?[]:[...new Set([parent.owner_id,...current.grant.viewers.filter(id=>id!==actor.subjectId)])]}}:{}),
      ...(actor&&actor.subjectId!==parent.owner_id&&this.assessorIds.has(actor.subjectId)?{reportDisclosure:{visibility:current.grant.visibility,
        viewers:current.grant.visibility==='Public'?[]:[...new Set([parent.owner_id,...current.grant.viewers.filter(id=>id!==actor.subjectId)])]}}:{})};
  }
  async exportNodeControl(actor,input){
    const parsed=nodeControlRequestSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');
    return this.access.runAuthorized(actor,'builders',async(db,authorization)=>{
      const loaded=await this.load(db,parsed.data.builderId),current=await this.current(db,actor,loaded),state=await this.nodeControl(db,actor,loaded,current);
      if(!this.signConformance||state.state!=='node-authorized-owner'||state.controlId!==parsed.data.controlId)throw new ServiceError('node_control_export_unavailable',409);
      const row=loaded.rows.find(item=>item.id===state.controlId),control=builderEventSchema.parse(JSON.parse(row.payload_text)),controlGrant=await this.grant(db,row);
      const bindings=(await db.query('SELECT expires_at FROM bindings WHERE id=ANY($1::uuid[])',[[controlGrant.bindingId,current.grant.bindingId]])).rows;
      const checkedAt=this.access.now(),expiresAt=Math.min(checkedAt+300,control.expiresAt,controlGrant.expiresAt,current.grant.expiresAt,...bindings.map(binding=>Math.floor(Date.parse(binding.expires_at)/1000)));
      if(!bindings.length||expiresAt<=checkedAt)throw new ServiceError('node_control_export_unavailable',409);
      const data=nodeControlSnapshotSchema.parse({version:1,id:row.id,builderId:loaded.parent.id,ownerId:loaded.parent.owner_id,nodeId:control.nodeId,
        declarationId:current.row.id,declarationHash:current.row.payload_hash,control,controlPayloadJson:row.payload_text,sourceEventHash:row.payload_hash,
        checkedAt,expiresAt,authority:'registry-attested-node-authorization',capabilityVerified:false,endpointControlVerified:false,
        maintenance:this.maintenance(loaded.rows),statusPath:'/v1/builders/node-control/export'});
      const signed=await this.signConformance('node-control',data,row.id,expiresAt-checkedAt);
      await this.auditExport(db,actor,authorization,row,'builder.node-control.export');return {signed};
    });
  }
  async auditExport(db,actor,authorization,row,action){
    const audit=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,
      client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,
      caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
      SELECT $1,$7,$2::text,COALESCE($3::text,$2::text),'accepted',1,ch.payload->>'installationId',b.audience,'builders',c.id,b.id,$3::uuid,COALESCE($3::text,$2::text),b.scopes,$4::jsonb,
        cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
      FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
      JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
      WHERE c.id=$6::uuid RETURNING sequence`,[actor.subjectId,row.id,actor.httpRequestId??null,JSON.stringify(authorization.credentialScopes),authorization.callerBindingId,row.consent_id,action]);
    if(audit.rows.length!==1)throw new Error('Builder export audit unavailable');
  }
  async exportReport(actor,input) {
    const parsed=conformanceRequestSchema.safeParse(input);
    if(!parsed.success)throw new ServiceError('invalid_builder_query');
    return this.access.runAuthorized(actor,'builders',async(db,authorization)=>{
      const current=await this.readWithin(db,actor,{builderId:parsed.data.builderId});
      const item=current.reports.find(report=>report.id===parsed.data.reportId);
      if(!this.signConformance||!item||item.validity!=='current'||!item.suiteStatus.portable)
        throw new ServiceError('conformance_report_unavailable',409);
      const rows=(await db.query('SELECT * FROM builder_events WHERE id=ANY($1::uuid[])',[[item.id,current.declarationId]])).rows;
      const row=rows.find(value=>value.id===item.id),declaration=rows.find(value=>value.id===current.declarationId);
      const reportGrant=await this.grant(db,row),declarationGrant=await this.grant(db,declaration);
      const checkedAt=this.access.now(),expiresAt=Math.min(checkedAt+300,item.expiresAt,item.suiteStatus.validUntil,reportGrant.expiresAt,declarationGrant.expiresAt);
      if(expiresAt<=checkedAt)throw new ServiceError('conformance_report_unavailable',409);
      const report=builderEventSchema.parse(JSON.parse(row.payload_text));
      const data=conformanceSnapshotSchema.parse({version:report.profile?2:1,id:item.id,builderId:current.builderId,ownerId:current.ownerId,assessorId:item.assessorId,
        declarationId:current.declarationId,declarationHash:current.declarationHash,
        release:{version:current.declaration.release.version,buildHash:current.declaration.release.buildHash,sourceCommit:current.declaration.release.sourceCommit},
        report,reportHash:digest(JSON.stringify(report)),sourceEventHash:row.payload_hash,checkedAt,expiresAt,
        suiteVerification:'operator-pinned-reference',authority:'registry-signed-assessor-report',capabilityVerified:false,independentExecutionVerified:false,
        maintenance:{delisted:current.delisted,securityIssue:current.securityIssue},statusPath:'/v1/builders/reports/export'});
      const signed=await this.signConformance('conformance',data,item.id,expiresAt-checkedAt);
      // The caller and source assessor differ. Preserve their binding contexts
      // separately, with a new row for each export and no report/token payload.
      await this.auditExport(db,actor,authorization,row,'builder.export');
      return {signed};
    });
  }
  get(actor,input){const parsed=builderReadSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');
    return actor?this.access.runAuthorized(actor,'builders',db=>this.readWithin(db,actor,parsed.data)):transaction(this.access.db,db=>this.readWithin(db,null,parsed.data));}
  query(actor,input={}, {publicOnly=false,candidateIds=null,sourceSearch=false}={}){const parsed=builderQuerySchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');const options=parsed.data;
    const read=async db=>{
      const viewer=publicOnly?null:actor;
      const rows=(await db.query(`SELECT p.id FROM builders p
        JOIN builder_events e ON e.builder_id=p.id AND e.kind='declare'
          AND NOT EXISTS(SELECT 1 FROM builder_events newer WHERE newer.builder_id=p.id AND newer.kind='declare' AND newer.revision>e.revision)
        JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id
        WHERE ($1::uuid IS NULL OR p.id>$1) AND ($2::text IS NULL OR p.type=$2) AND ($3::text IS NULL OR p.owner_id=$3)
          AND ($7::uuid[] IS NULL OR p.id=ANY($7))
          AND c.subject_id=e.subject_id AND b.subject_id=e.subject_id AND c.revoked_at IS NULL AND b.revoked_at IS NULL AND c.expires_at>$5 AND b.expires_at>$5
          AND c.intent->>'recipient'=$6 AND c.intent->>'action'='builder.publish' AND c.intent->>'objectId'=e.id::text AND c.intent->>'payloadHash'=e.payload_hash
          AND (p.owner_id=$4 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile'
            OR c.intent->>'visibility'='Private' AND c.intent->'viewers' ? COALESCE($4,''))
        ORDER BY p.id LIMIT 201`,[options.after??null,options.type??null,options.ownerId??null,viewer?.subjectId??null,new Date(this.access.now()*1000).toISOString(),this.access.endpoint,candidateIds])).rows,items=[];let last=null;
      for(const row of rows.slice(0,200)){try{
        const item=await this.readWithin(db,viewer,{builderId:row.id});
        if(item.delisted&&viewer?.subjectId!==item.ownerId)continue;
        last=row.id;
        const fields=builderSearchFields(item.declaration),terms=[...new Set(options.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean))];
        const matches=terms.map(term=>({term,fields:Object.keys(fields).filter(key=>fields[key].toLocaleLowerCase('en-US').includes(term))}));
        if(sourceSearch?matches.some(match=>!match.fields.length):!`${item.declaration.name} ${item.declaration.scope}`.toLowerCase().includes(options.query.toLowerCase()))continue;
        items.push({builderId:item.builderId,ownerId:item.ownerId,type:item.type,name:item.declaration.name,version:item.declaration.release.version,
          registration:item.registration,nodeControl:item.nodeControl,compatibility:item.compatibility,reachability:item.reachability,evidence:item.evidence.state,securityIssue:item.securityIssue,
          ...(sourceSearch?{revision:item.revision,declarationId:item.declarationId,declarationHash:item.declarationHash,scope:item.declaration.scope,
            matchReasons:matches.length?matches.map(match=>`${match.term} → ${match.fields.join(', ')}`):['current public declaration; source ID order']}:{})});
        if(items.length>options.limit)break;
      }catch(error){if(!(error instanceof ServiceError))throw error;}}
      const page=items.slice(0,options.limit),windowLimited=items.length<=options.limit&&rows.length>200;
      return {items:page,nextAfter:items.length>options.limit?page.at(-1).builderId:windowLimited?last:null,windowLimited,automaticEndpointProbes:false};
    };
    return actor?this.access.runAuthorized(actor,'builders',read):transaction(this.access.db,read);
  }
}
