import {builderEventSchema} from "../shared/builders-schema.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {digest} from "../shared/digest.mjs";
import {conformanceRequestSchema,conformanceSnapshotSchema} from "../shared/conformance-schema.mjs";
import {nodeControlRequestSchema,nodeControlSnapshotSchema} from "../shared/node-control-proof-schema.mjs";
import {BuilderReadModel} from './read-model.mjs';

// Exact Node control/conformance snapshots, current declarations and source expiries, using the original signer arguments and caller-versus-source audit bindings.
export class BuilderPortableEvidence extends BuilderReadModel{
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
}
