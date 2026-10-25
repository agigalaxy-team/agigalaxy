import {builderReadSchema,builderQuerySchema,conformanceChecks,builderSearchFields} from "../shared/builders-schema.mjs";
import {builderOwnedQuerySchema,builderReceiptSchema,builderNoticesSchema,builderRecoveryActions} from "../shared/builders-schema.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {transaction} from "../database.mjs";
import {suiteValidity,reportCoverage} from "../shared/conformance-schema.mjs";
import {readBuilderWorkEvidence} from "../domain/builder-work-evidence.mjs";
import {readBuilderProbe} from "../domain/builder-probe-source.mjs";
import {BuilderAuthority} from './authority.mjs';

// Original public/current-source and owner-only projections, original accepted-event receipts and bounded source-search/maintenance pagination.
export class BuilderReadModel extends BuilderAuthority{
  specification() { return {version:'0.1',types:['worker','bridge','hub'],checks:conformanceChecks,
    compatibilityAuthority:'configured-assessor-reported; exact declaration and suite digest',
    workEvidence:{supported:true,authority:'node-signed-source-association',requiredSources:['case','attempt','result','ci-proof'],maxProofReferences:8,
      currentSourcesChecked:true,executionAttributionVerified:false,taskReferenceAuthority:'node-declared'},
    automaticEndpointProbes:false,reachabilityProbeMode:'explicit-node-request; A2A 1.0 JSONRPC read only',workerExecution:false,hubConnection:false,capabilityVerified:false}; }
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
