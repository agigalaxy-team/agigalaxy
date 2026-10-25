import {builderAssessorIdsSchema} from "../shared/builders-schema.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {canReadProjection} from "../domain/consent-policy.mjs";
import {conformanceSuitePinsSchema} from "../shared/conformance-schema.mjs";

// Registry owner, Node holder and configured assessor remain separate authorities; exact current declaration/grant and original control revocation are never replaced by capability claims.
export class BuilderAuthority{
  constructor(access,consents,proofs,assessorIds=[],{suitePins=[],sign}={}) {
    Object.assign(this,{access,consents,proofs}); this.assessorIds=new Set(builderAssessorIdsSchema.parse(assessorIds));
    this.suitePins=conformanceSuitePinsSchema.parse(suitePins); this.signConformance=sign;
  }
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
  maintenance(rows){let delisted=false,securityIssue=false;
    for(const row of rows)if(row.kind==='maintenance'){
      const {action}=JSON.parse(row.payload_text);
      if(action==='delist')delisted=true;if(action==='relist')delisted=false;
      if(action==='security-issue')securityIssue=true;if(action==='resolve-security')securityIssue=false;
    }
    return {delisted,securityIssue};
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
}
