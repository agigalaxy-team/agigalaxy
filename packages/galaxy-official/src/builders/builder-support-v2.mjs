import {builderExtensionEventSchema,builderExtensionReadSchema,builderPackExportSchema} from "../shared/builder-support-v2-schema.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {digest} from "../shared/digest.mjs";
import {transaction} from "../infrastructure/database.mjs";
import {recordObjectAudit} from "../infrastructure/object-audit.mjs";
import {suiteValidity} from "../shared/conformance-schema.mjs";
import {packManifestReadSchema} from "../shared/worker-pack-uses-v2-schema.mjs";

const extensionKinds=new Set(['support-profile','pack-manifest','scope-report']);
const parse=row=>row?.payload_text ? JSON.parse(row.payload_text) : null;
const latest=(rows,kind)=>rows.findLast(row=>row.kind===kind);
const equalViewers=(a,b)=>JSON.stringify([...a].sort((left,right)=>left<right?-1:left>right?1:0))===JSON.stringify([...b].sort((left,right)=>left<right?-1:left>right?1:0));
export class BuilderSupportV2Service {
  constructor(builders){this.builders=builders;this.access=builders.access;}
  specification(){return {profile:'galaxy-builder-support/2',eventKinds:[...extensionKinds],
    declarationAuthority:'builder-declared',reportAuthority:'configured-assessor-reported',
    pack:{profile:'galaxy-worker-pack/1',distribution:'external-reference-only',execution:'user-controlled',
      createsAttempt:false,automaticallyInstalls:false},capabilityVerified:false,hubConnection:false,workerExecution:false};}
  grant(db,row){return this.builders.grant(db,row);}
  async manifestWithin(db,actor,input){
    const p=packManifestReadSchema.parse(input),loaded=await this.builders.load(db,p.builderId);
    const current=await this.builders.current(db,actor,loaded);
    const row=loaded.rows.find(row=>row.id===p.manifestId&&row.kind==='pack-manifest');
    if(!row?.payload_text||!await this.permitted(db,actor,row))throw new ServiceError('builder_pack_unavailable',404);
    if(digest(row.payload_text)!==row.payload_hash)throw new ServiceError('builder_pack_integrity_mismatch',500);
    if(p.manifestHash&&p.manifestHash!==row.payload_hash)throw new ServiceError('builder_pack_hash_mismatch',409);
    const event=builderExtensionEventSchema.parse(JSON.parse(row.payload_text));
    const declaration=loaded.rows.find(r=>r.id===event.declarationId&&r.kind==='declare');
    if(!declaration?.payload_text||declaration.payload_hash!==event.declarationHash||!await this.permitted(db,actor,declaration))
      throw new ServiceError('builder_pack_declaration_unavailable',404);
    const published=JSON.parse(declaration.payload_text).declaration;
    if(published.type!=='worker'||event.manifest.version!==published.release.version||event.manifest.sha256!==published.release.buildHash
      ||event.manifest.source!==published.release.artifact)throw new ServiceError('builder_pack_release_mismatch',409);
    const currentPack=latest(loaded.rows,'pack-manifest'),state=this.builders.maintenance(loaded.rows);
    return {builderId:p.builderId,manifestId:row.id,manifestHash:row.payload_hash,authorId:row.subject_id,
      declarationId:declaration.id,manifest:event.manifest,versionStatus:current.row.id===declaration.id&&currentPack?.id===row.id?'current':'historical-version',
      ...state,installationPerformed:false,workerStarted:false,capabilityVerified:false};
  }
  manifest(actor,input){
    const p=packManifestReadSchema.safeParse(input);if(!p.success)throw new ServiceError('invalid_builder_query',400);
    return actor?this.access.runAuthorized(actor,'builders',db=>this.manifestWithin(db,actor,p.data))
      :transaction(this.access.db,db=>this.manifestWithin(db,null,p.data));
  }
  async permitted(db,actor,row){
    if(!row?.payload_text)return false;
    try{return this.builders.visible(await this.grant(db,row),actor);}
    catch(error){if(error instanceof ServiceError)return false;throw error;}
  }
  async readWithin(db,actor,input){
    const loaded=await this.builders.load(db,input.builderId),current=await this.builders.current(db,actor,loaded);
    const state=this.builders.maintenance(loaded.rows),supportRow=latest(loaded.rows,'support-profile'),packRow=latest(loaded.rows,'pack-manifest');
    const currentExtension=async row=>{
      if(!row)return {state:'not-declared',record:null};
      // A newer unavailable extension never falls back to an older public one.
      const event=parse(row);
      if(!event||!await this.permitted(db,actor,row))return {state:'unavailable',record:null};
      if(event.declarationId!==current.row.id||event.declarationHash!==current.row.payload_hash)
        return {state:'stale-declaration',eventId:row.id,revision:row.revision,record:null};
      return {state:'current',eventId:row.id,payloadHash:row.payload_hash,revision:row.revision,record:event};
    };
    const support=await currentExtension(supportRow),pack=await currentExtension(packRow),reports=[],lastReports=new Map();
    for(const row of loaded.rows)if(row.kind==='scope-report'){
      const event=parse(row);if(event)lastReports.set(JSON.stringify([row.subject_id,event.run.testClass]),row.id);
    }
    for(const row of loaded.rows)if(row.kind==='scope-report'&&await this.permitted(db,actor,row)){
      const event=parse(row),suiteStatus=suiteValidity(event.suite,this.builders.suitePins,this.access.now(),event.observedAt);
      const validity=event.declarationId!==current.row.id||event.declarationHash!==current.row.payload_hash?'stale-declaration'
        :support.state!=='current'||event.supportId!==support.eventId||event.supportHash!==support.payloadHash?'stale-support'
        :lastReports.get(JSON.stringify([row.subject_id,event.run.testClass]))!==row.id?'superseded'
        :!this.builders.assessorIds.has(row.subject_id)?'assessor-removed'
        :event.expiresAt<=this.access.now()?'expired'
        :!['current','untracked'].includes(suiteStatus.state)?'suite-'+suiteStatus.state:'current';
      reports.push({...event,assessorId:row.subject_id,validity,suiteStatus,
        authority:'configured-assessor-reported',independentExecutionVerified:false,capabilityVerified:false});
    }
    const active=reports.filter(row=>row.validity==='current');
    const testedScopes=(support.record?.support.objectActions??[]).map(action=>{
      const observations=active.flatMap(report=>report.checks.filter(check=>check.action===action).map(check=>({
        reportId:report.id,assessorId:report.assessorId,testClass:report.run.testClass,status:check.status,detail:check.detail
      })));
      return {action,state:observations.some(item=>item.status==='fail')?'reported-fail'
        :observations.some(item=>item.status==='pass')?'reported-pass':'not-tested',observations,
        authority:'scoped-assessor-report; no professional certification'};
    });
    return {builderId:loaded.parent.id,ownerId:loaded.parent.owner_id,type:loaded.parent.type,revision:loaded.parent.revision,
      declarationId:current.row.id,declarationHash:current.row.payload_hash,release:current.payload.release,
      support:{...support,record:support.record?.support??null,testedScopes},
      pack:{...pack,record:pack.record?.manifest??null,packId:loaded.parent.type==='worker'?loaded.parent.id:null,
        authorId:loaded.parent.owner_id,identityMeaning:'typed pack reference within this worker registration',
        installation:'not-performed-by-registry',runtime:'not-started-by-registry',actualUseCount:null},
      reports,...state,checkedAt:this.access.now(),capabilityVerified:false,
      canSubmitReport:!!actor&&actor.subjectId!==loaded.parent.owner_id&&this.builders.assessorIds.has(actor.subjectId),
      disclosure:actor?.subjectId===loaded.parent.owner_id?{visibility:current.grant.visibility,viewers:current.grant.viewers}:null,
      reportDisclosure:actor&&actor.subjectId!==loaded.parent.owner_id&&this.builders.assessorIds.has(actor.subjectId)?
        {visibility:current.grant.visibility,viewers:current.grant.visibility==='Public'?[]:[...new Set([loaded.parent.owner_id,...current.grant.viewers.filter(id=>id!==actor.subjectId)])]}:null};
  }
  get(actor,input){const parsed=builderExtensionReadSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');
    return actor?this.access.runAuthorized(actor,'builders',db=>this.readWithin(db,actor,parsed.data))
      :transaction(this.access.db,db=>this.readWithin(db,null,parsed.data));}
  async publish(actor,{consentId,payloadJson}){
    let event;try{if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>28000)throw new Error();
      event=builderExtensionEventSchema.parse(JSON.parse(payloadJson));}catch{throw new ServiceError('invalid_builder_extension');}
    return this.access.runResourceWrite(actor,'builders',{},async(db,authorization)=>{
      const loaded=await this.builders.load(db,event.builderId,'UPDATE'),{parent,rows}=loaded,assessor=event.kind==='scope-report';
      if(assessor?actor.subjectId===parent.owner_id||!this.builders.assessorIds.has(actor.subjectId):actor.subjectId!==parent.owner_id)
        throw new ServiceError(assessor?'builder_assessor_required':'builder_owner_required',403);
      const grant=await this.grant(db,{id:event.id,subject_id:actor.subjectId,consent_id:consentId,payload_text:payloadJson});
      const prior=(await db.query('SELECT * FROM builder_events WHERE id=$1',[event.id])).rows[0];
      if(prior){
        if(prior.builder_id!==event.builderId||prior.subject_id!==actor.subjectId||prior.payload_hash!==digest(payloadJson)||prior.consent_id!==consentId)
          throw new ServiceError('builder_event_conflict',409);
        return {builderId:event.builderId,eventId:prior.id,revision:prior.revision};
      }
      if(parent.revision!==event.expectedRevision||parent.revision>=1000)throw new ServiceError('builder_revision_conflict',409);
      const current=await this.builders.current(db,actor,loaded);
      if(event.declarationId!==current.row.id||event.declarationHash!==current.row.payload_hash)throw new ServiceError('builder_declaration_changed',409);
      if(!['Public','Private'].includes(grant.visibility)||grant.visibility!==current.grant.visibility
        ||(assessor?grant.visibility==='Private'&&(!grant.viewers.includes(parent.owner_id)||grant.viewers.some(id=>id!==parent.owner_id&&!current.grant.viewers.includes(id)))
          :!equalViewers(grant.viewers,current.grant.viewers)))throw new ServiceError('builder_visibility_mismatch',403);
      if(event.kind==='pack-manifest'){
        if(parent.type!=='worker')throw new ServiceError('builder_worker_required',409);
        if(event.manifest.version!==current.payload.release.version||event.manifest.sha256!==current.payload.release.buildHash
          ||event.manifest.source!==current.payload.release.artifact)throw new ServiceError('builder_pack_release_mismatch',409);
      }
      if(event.kind==='support-profile'){
        if(event.support.implementation.version!==current.payload.release.version)throw new ServiceError('builder_support_release_mismatch',409);
        if(parent.type==='bridge'&&!event.support.mapping)throw new ServiceError('builder_mapping_required',409);
        if(parent.type==='bridge'&&(event.support.mapping.version!==current.payload.mapping.version
          ||event.support.mapping.sourceSystem!==current.payload.mapping.sourceSystem
          ||event.support.mapping.strengthCeiling!==current.payload.mapping.strengthCeiling))throw new ServiceError('builder_mapping_mismatch',409);
      }
      if(assessor){
        const support=latest(rows,'support-profile'),payload=parse(support);
        if(!payload||!await this.permitted(db,actor,support)||support.id!==event.supportId||support.payload_hash!==event.supportHash
          ||payload.declarationId!==event.declarationId||payload.declarationHash!==event.declarationHash
          ||event.checks.some(check=>!payload.support.objectActions.includes(check.action)))throw new ServiceError('builder_support_changed',409);
        if(event.observedAt>this.access.now()||event.observedAt<this.access.now()-2592000||event.expiresAt<=this.access.now()
          ||event.expiresAt<=event.observedAt||event.expiresAt-event.observedAt>2592000)throw new ServiceError('builder_report_mismatch',409);
        if(event.run.testClass==='independent-interop'&&!event.run.peer)throw new ServiceError('builder_report_peer_required',409);
        // Reusing a run cannot multiply observations or silently replace its bytes.
        const sameRun=rows.filter(row=>row.kind==='scope-report'&&row.subject_id===actor.subjectId).map(parse).find(row=>row?.run.id===event.run.id);
        if(sameRun)throw new ServiceError('builder_report_run_exists',409);
      }
      const revision=parent.revision+1;
      await db.query('INSERT INTO builder_events(id,builder_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [event.id,event.builderId,actor.subjectId,revision,event.kind,consentId,payloadJson,digest(payloadJson),this.access.now()]);
      await db.query('UPDATE builders SET revision=$2 WHERE id=$1',[event.builderId,revision]);
      await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:event.id,action:'builder.event',httpRequestId:actor.httpRequestId??null,...authorization});
      return {builderId:event.builderId,eventId:event.id,revision};
    });
  }
  async exportPack(actor,input){const parsed=builderPackExportSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');
    const read=async db=>{
      const value=await this.readWithin(db,actor,parsed.data);
      if(value.pack.state!=='current'||value.pack.eventId!==parsed.data.manifestId)throw new ServiceError('builder_pack_unavailable',404);
      if(value.delisted||value.securityIssue)throw new ServiceError('builder_pack_maintenance_blocked',409);
      return {schemaVersion:1,kind:'galaxy-worker-pack-reference',packId:value.pack.packId,authorId:value.ownerId,builderId:value.builderId,
        declarationId:value.declarationId,declarationHash:value.declarationHash,manifestId:value.pack.eventId,
        payloadHash:value.pack.payloadHash,manifest:value.pack.record,checkedAt:this.access.now(),
        authority:'author-declared-selected-metadata',signatureVerification:'use-original-consent-or-separate-signed-proof',
        currentRevocationMustBeRechecked:true,installationPerformed:false,workerStarted:false,capabilityVerified:false};
    };
    return actor?this.access.runAuthorized(actor,'builders',read):transaction(this.access.db,read);
  }
}
