import * as z from 'zod/v4';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { trustCanonical,verifyTrustJws,trustSubject } from './shared/trust-package-crypto.mjs';
import { trustPermissionSchema,trustSourceRefSchema,trustAudienceSchema } from './shared/trust-package-schema.mjs';
import { trustAudienceAllows } from './trust-package.mjs';
import { currentControlKey,lockSubjectControl } from './infrastructure/identity-control-repository.mjs';
import { createTrustSourceReader } from './trust-package-source-reader.mjs';
const rule=(v,c,s=409)=>{if(!v)throw new ServiceError(c,s);};
const parse=(s,v)=>{try{return s.parse(v);}catch{throw new ServiceError('invalid_trust_input',422);}};
const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];
const iso=n=>new Date(n*1000).toISOString(), same=(a,b)=>trustCanonical(a)===trustCanonical(b);
export const trustPermissionPreviewSchema=z.strictObject({id:z.uuid(),operationId:z.uuid(),source:trustSourceRefSchema,
  grantee:trustSubject,audience:trustAudienceSchema,expiresAt:z.number().int().nonnegative()});
export const trustSelectionSchema=z.strictObject({selections:z.array(z.strictObject({ref:trustSourceRefSchema,
  mode:z.enum(['reference','copy']),permissionId:z.uuid().optional()})).max(50),audience:trustAudienceSchema,expiresAt:z.number().int().positive()});
export const trustPermissionMutationSchema=z.strictObject({signed:z.string().max(30000)});
export const trustPermissionLookupSchema=z.strictObject({id:z.uuid()});
export const trustPermissionRevokeSchema=z.strictObject({id:z.uuid(),operationId:z.uuid()});
export const trustPermissionQuerySchema=z.strictObject({after:z.uuid().nullable().default(null),role:z.enum(['author','grantee']).default('author')});

export class TrustPackagePermissionService {
  constructor(access,{cases,verificationRecords,ciV2,readSourceWithin}={}) {
    this.access=access;this.endpoint=access.endpoint;this.now=()=>access.now();
    this.readSourceWithin=readSourceWithin??createTrustSourceReader({cases,verificationRecords,ciV2});
  }
  async identityWithin(db,id){
    const subject=await lockSubjectControl(db,id);rule(subject,'trust_identity_unavailable',404);
    return {subjectId:id,genesisProof:subject.genesis_proof,
      events:(await db.query('SELECT * FROM subject_control_events WHERE subject_id=$1 ORDER BY sequence',[id])).rows,
      authority:this.endpoint,checkedAt:this.now()};
  }
  localSource(ref){rule(ref.endpoint===this.endpoint,'trust_source_endpoint_mismatch',422);}
  sourceScope(a,ref){rule(a.credentialScopes.includes(ref.kind==='case-event'?'case-teaser':['evidence','verification'].includes(ref.kind)?'evidence':'proof'),'trust_source_scope_required',403);}
  async ownSourceWithin(db,actor,ref){
    this.localSource(ref); const source=await this.readSourceWithin(db,actor,ref);
    rule(source.authorId===actor.subjectId,'trust_original_author_required',403);return source;
  }
  async preview(actor,input){const q=parse(trustPermissionPreviewSchema,input);return this.access.runAuthorized(actor,'consent',async(db,a)=>{
    this.sourceScope(a,q.source);const source=await this.ownSourceWithin(db,actor,q.source);rule(source.copyEligible,'trust_linked_source_permission_required');
    const control=a.identityControl??await currentControlKey(db,actor.subjectId,{scope:'consent'});
    const p=parse(trustPermissionSchema,{...q,version:1,type:'galaxy-trust-source-permission',kind:'grant',subjectId:actor.subjectId,
      bindingId:actor.bindingId,endpoint:this.endpoint,sourceHash:source.sourceHash,originalSignatureHash:null,
      purpose:'trust-package-only',permission:'copy-exact-authored-record',trainingAllowed:false,onlineAccessGranted:false,
      sourceAuthorDeclaration:'I authorize the exact authored record; no third-party source bodies are included',
      keyId:control.keyId,epoch:control.epoch,chainHead:control.chainHead,issuedAt:this.now()});
    return {payloadJson:trustCanonical(p),signatureType:'galaxy-trust-source-permission-v1+jws',sourcePreview:source,
      granted:false,declineEffect:'No signed permission is submitted.'};
  });}
  async revokePreview(actor,input){const q=parse(trustPermissionRevokeSchema,input);return this.access.runAuthorized(actor,'consent',async(db,a)=>{
    const row=await one(db,'SELECT * FROM trust_package_permissions WHERE id=$1 AND subject_id=$2',[q.id,actor.subjectId]);rule(row,'trust_permission_unavailable',404);
    const control=a.identityControl??await currentControlKey(db,actor.subjectId,{scope:'consent'});
    const p=parse(trustPermissionSchema,{...JSON.parse(row.payload_text),kind:'revoke',operationId:q.operationId,bindingId:actor.bindingId,
      keyId:control.keyId,epoch:control.epoch,chainHead:control.chainHead,issuedAt:this.now(),expiresAt:this.now()+300});
    return {payloadJson:trustCanonical(p),signatureType:'galaxy-trust-source-permission-v1+jws',permissionId:q.id,
      externalCopiesDeleted:false,revoked:!!row.revoked_at};
  });}
  async submit(actor,input){const q=parse(trustPermissionMutationSchema,input);return this.access.runResourceWrite(actor,'consent',{},async(db,a)=>{
    const control=a.identityControl??await currentControlKey(db,actor.subjectId,{scope:'consent'});
    let text,p;try{text=await verifyTrustJws(q.signed,control.publicKey,'galaxy-trust-source-permission-v1+jws');p=trustPermissionSchema.parse(JSON.parse(text));}
    catch{throw new ServiceError('invalid_trust_signature',400);}
    rule(p.subjectId===actor.subjectId&&p.bindingId===actor.bindingId&&p.endpoint===this.endpoint&&p.keyId===control.keyId
      &&p.epoch===control.epoch&&p.chainHead===control.chainHead,'trust_signer_context_changed',403);
    this.localSource(p.source);const hash=digest(q.signed);
    const existing=await one(db,'SELECT * FROM trust_package_permissions WHERE id=$1 FOR UPDATE',[p.id]);
    if(p.kind==='grant'&&existing){rule(existing.subject_id===actor.subjectId&&existing.signature_hash===hash,'trust_permission_conflict');return this.receiptRow(existing);}
    if(p.kind==='revoke'&&existing?.revoke_operation_id===p.operationId){rule(existing.subject_id===actor.subjectId&&existing.revoke_signature_hash===hash,'trust_permission_conflict');return this.receiptRow(existing);}
    rule(Math.abs(p.issuedAt-this.now())<=300&&p.expiresAt>this.now(),'trust_permission_time_changed');
    if(p.kind==='grant'){
      this.sourceScope(a,p.source);
      rule(p.originalSignatureHash===null,'trust_original_signature_copy_not_authorized');
      const source=await this.ownSourceWithin(db,actor,p.source);rule(source.copyEligible,'trust_linked_source_permission_required');
      rule(source.sourceHash===p.sourceHash,'trust_source_changed');
      const identity=await this.identityWithin(db,actor.subjectId);
      await db.query(`INSERT INTO trust_package_permissions(id,subject_id,grantee_id,operation_id,payload_text,signed,signature_hash,identity,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[p.id,actor.subjectId,p.grantee,p.operationId,text,q.signed,hash,JSON.stringify(identity),iso(p.issuedAt),iso(p.expiresAt)]);
      const saved=await one(db,'SELECT * FROM trust_package_permissions WHERE id=$1 FOR UPDATE',[p.id]);
      rule(saved?.signature_hash===hash,'trust_permission_conflict');await this.auditWithin(db,actor,a,p);return this.receiptRow(saved);
    }
    rule(existing&&existing.subject_id===actor.subjectId,'trust_permission_unavailable',404);
    const old=JSON.parse(existing.payload_text);
    for(const field of ['source','sourceHash','grantee','audience','originalSignatureHash'])rule(same(p[field],old[field]),'trust_revoke_scope_changed');
    rule(!existing.revoked_at,'trust_permission_already_revoked');
    await db.query(`UPDATE trust_package_permissions SET revoked_at=$2,revoke_operation_id=$3,revoke_payload_text=$4,revoke_signed=$5,revoke_signature_hash=$6 WHERE id=$1`,
      [p.id,iso(this.now()),p.operationId,text,q.signed,hash]);
    await this.auditWithin(db,actor,a,p);return this.receiptRow(await one(db,'SELECT * FROM trust_package_permissions WHERE id=$1',[p.id]));
  });}
  async auditWithin(db,actor,a,p){
    await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,
      binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
      SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'consent',b.id,$5,$4,b.scopes,$6::jsonb,
      b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id
      WHERE b.id=$7 AND b.subject_id=$1`,[actor.subjectId,'trust.permission.'+p.kind,p.id,p.operationId,actor.httpRequestId??null,JSON.stringify(a.credentialScopes),a.callerBindingId]);
  }
  receiptRow(row){return {id:row.id,state:'recorded',operationId:row.operation_id,signatureHash:row.signature_hash,
    revokeOperationId:row.revoke_operation_id??null,revokeSignatureHash:row.revoke_signature_hash??null,
    status:row.revoked_at?'revoked':Date.parse(row.expires_at)<=this.now()*1000?'expired':'recorded-needs-current-source-check',externalCopiesDeleted:false};}
  receipt(actor,input){const q=parse(trustPermissionLookupSchema,input);return this.access.runAuthorized(actor,'consent',async db=>{
    const row=await one(db,'SELECT * FROM trust_package_permissions WHERE id=$1 AND subject_id=$2',[q.id,actor.subjectId]);
    return row?this.receiptRow(row):{id:q.id,state:'absent'};
  });}
  async usableWithin(db,row){
    if(row.revoked_at)return {status:'revoked'};
    if(Date.parse(row.expires_at)<=this.now()*1000)return {status:'expired'};
    const p=JSON.parse(row.payload_text);
    try {
      const binding=await one(db,'SELECT subject_id,revoked_at,expires_at FROM bindings WHERE id=$1',[p.bindingId]);
      rule(binding&&binding.subject_id===row.subject_id&&!binding.revoked_at&&Date.parse(binding.expires_at)>this.now()*1000,'trust_binding_unavailable');
      await currentControlKey(db,row.subject_id,{keyId:p.keyId,epoch:p.epoch,scope:'consent'});
      const source=await this.ownSourceWithin(db,{subjectId:row.subject_id},p.source);
      rule(source.copyEligible&&source.sourceHash===p.sourceHash,'trust_source_changed');
      return {status:'active',source};
    } catch(error){if(!(error instanceof ServiceError))throw error;return {status:'source-or-control-unavailable',reason:error.code};}
  }
  async visibleRowWithin(db,actor,id){
    const row=await one(db,'SELECT * FROM trust_package_permissions WHERE id=$1',[id]);rule(row,'trust_permission_unavailable',404);
    const p=JSON.parse(row.payload_text);
    rule(row.subject_id===actor.subjectId||row.grantee_id===actor.subjectId||p.audience.kind==='public'||p.audience.subjectIds.includes(actor.subjectId),'trust_permission_unavailable',404);
    return row;
  }
  status(actor,input){const q=parse(trustPermissionLookupSchema,input);return this.access.runAuthorized(actor,'consent',async db=>{
    const row=await this.visibleRowWithin(db,actor,q.id),current=await this.usableWithin(db,row);
    return {id:q.id,status:current.status,reason:current.reason??null,checkedAt:this.now(),sourceAccessGranted:false,
      currentRevocationChecked:true,externalCopiesDeleted:false};
  });}
  query(actor,input={}){const q=parse(trustPermissionQuerySchema,input);return this.access.runAuthorized(actor,'consent',async db=>{
    const rows=(await db.query(`SELECT * FROM trust_package_permissions WHERE ${q.role==='author'?'subject_id':'grantee_id'}=$1
      AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 51`,[actor.subjectId,q.after])).rows,items=[];
    for(const row of rows.slice(0,50)){const p=JSON.parse(row.payload_text),current=await this.usableWithin(db,row);
      items.push({id:row.id,subjectId:row.subject_id,granteeId:row.grantee_id,source:p.source,sourceHash:p.sourceHash,
        audience:p.audience,expiresAt:p.expiresAt,status:current.status,reason:current.reason??null});}
    return {items,nextAfter:rows.length>50?rows[49].id:null,checkedAt:this.now(),sourceAccessGranted:false};
  });}
  sources(actor,input){const q=parse(trustSelectionSchema,input);return this.access.runAuthorized(actor,'consent',async(db,a)=>{
    rule(q.expiresAt>this.now()&&q.expiresAt<=this.now()+30*86400,'trust_package_expiry_invalid');
    const items=[];
    for(const selection of q.selections){
      try {
        this.localSource(selection.ref);let source,permission;
        if(selection.ref.kind==='ci-proof-v2'){
          rule(selection.mode==='reference'&&!selection.permissionId,'trust_ci_reference_only',403);
          this.sourceScope(a,selection.ref);source=await this.readSourceWithin(db,actor,selection.ref);
          rule(source.profile==='galaxy-ci-proof-v2-reference/1'
            &&source.associatedSubjectId===actor.subjectId,'trust_ci_associated_subject_required',403);
          rule(q.expiresAt<=source.sourceExpiresAt,'trust_ci_reference_expiry_exceeds_source',409);
          const snapshot={ref:source.ref,profile:source.profile,issuer:source.issuer,associatedSubjectId:source.associatedSubjectId,
            sourceHash:source.sourceHash,sourceSignatureHash:source.sourceSignatureHash,sourceExpiresAt:source.sourceExpiresAt,
            authority:source.authority,sourceState:source.sourceState,checkedAt:this.now(),mode:'reference',
            signatureEvidence:'not-provided',referenceBasis:'associated-subject-reference',limitations:source.limitations};
          items.push({ref:selection.ref,state:'available',snapshot});continue;
        }
        if(selection.permissionId){
          const row=await this.visibleRowWithin(db,actor,selection.permissionId),p=JSON.parse(row.payload_text);
          rule(p.grantee===actor.subjectId&&same(p.source,selection.ref)&&trustAudienceAllows(p.audience,q.audience)
            &&p.expiresAt>=q.expiresAt,'trust_permission_scope_mismatch',403);
          const current=await this.usableWithin(db,row);rule(current.status==='active',current.reason??'trust_permission_'+current.status);
          source=current.source;permission={signed:row.signed,identity:row.identity,status:'active',checkedAt:this.now()};
        } else {
          // Private borrowed reading is not enough even for portable metadata.
          this.sourceScope(a,selection.ref);source=await this.ownSourceWithin(db,actor,selection.ref);
        }
        rule(selection.mode==='reference'||permission,'trust_reproduction_permission_required',403);
        const snapshot={ref:source.ref,authorId:source.authorId,sourceHash:source.sourceHash,authority:source.authority,
          sourceState:source.sourceState,checkedAt:this.now(),mode:selection.mode,signatureEvidence:'not-provided',
          referenceBasis:permission?'explicit-trust-permission':'own-authored-reference',limitations:source.limitations,
          ...(selection.mode==='copy'?{bodyText:source.bodyText,permission}:{})};
        items.push({ref:selection.ref,state:'available',snapshot});
      } catch(error){if(!(error instanceof ServiceError))throw error;items.push({ref:selection.ref,state:'unavailable',reason:error.code});}
    }
    return {items,checkedAt:this.now(),uploadedPackage:false,modelCalls:0};
  });}
}
