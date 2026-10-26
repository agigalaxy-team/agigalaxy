import {builderEventSchema,builderReadSchema} from "../shared/builders-schema.mjs";
import {builderRecoveryActions} from "../shared/builders-schema.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {digest} from "../shared/digest.mjs";
import {recordObjectAudit} from "../infrastructure/object-audit.mjs";
import {readBuilderWorkSources} from "../domain/builder-work-evidence.mjs";
import {builderProbeTarget} from "./builder-probe-observer.mjs";
import {randomUUID} from "node:crypto";
import {BuilderPortableEvidence} from './portable-evidence.mjs';

// Original publication transaction remains whole: separate owner/Node/assessor intents, exact CAS/receipts, source checks and explicit request-only probe queue.
export class BuilderService extends BuilderPortableEvidence{
  constructor(access,consents,proofs,assessorIds=[],{suitePins=[],sign}={}){super(access,consents,proofs,assessorIds,{suitePins,sign});}

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
  manage(actor,input){const parsed=builderReadSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_builder_query');
    return this.access.runAuthorized(actor,'builders',db=>this.managementWithin(db,actor,parsed.data.builderId));}
}
