import { randomBytes } from 'node:crypto';
import { transaction } from './database.mjs';
import { verifyGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { controlOperationSchema,controlCommitSchema,controlSubject } from './shared/identity-control-schema.mjs';
import { currentControlKey,lockSubjectControl } from './infrastructure/identity-control-repository.mjs';
import { controlCanonical,controlKeyId,controlEventHash,verifyControlSignature } from './domain/identity-control.mjs';
const iso=seconds=>new Date(seconds*1000).toISOString();
const parse=(schema,input)=>{const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_identity_control_request');return result.data;};
const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];

export class IdentityControlService {
  constructor({db,endpoint,now=()=>Math.floor(Date.now()/1000),allowedScopes=[]}) {
    this.db=db;this.endpoint=endpoint;this.now=now;this.allowedScopes=new Set(['manage-identity',...allowedScopes]);
  }
  async challenge(input){
    const request=parse(controlOperationSchema,input),requestHash=controlKeyId(controlCanonical(request));
    if(request.kind==='bootstrap'&&(!verifyGalaxyGenesis(request.subjectId,request.genesisProof)
      ||request.newDevice.publicKeyPem!==request.genesisProof.publicKeyPem||request.signerKeyId!==controlKeyId(request.genesisProof.publicKeyPem)))
      throw new ServiceError('identity_control_proof_invalid',401);
    if(request.newDevice?.scopes.some(s=>!this.allowedScopes.has(s)&&!(s==='*'&&request.kind==='bootstrap')))
      throw new ServiceError('identity_scope_invalid');
    const challenge=controlCanonical({version:2,type:'identity-control',audience:this.endpoint,request,
      nonce:randomBytes(32).toString('base64url'),expiresAt:this.now()+180});
    await this.db.query(`INSERT INTO identity_control_operations(id,subject_id,request_hash,request,challenge_text,expires_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[request.operationId,request.subjectId,requestHash,JSON.stringify(request),challenge,iso(this.now()+180)]);
    const row=await one(this.db,'SELECT * FROM identity_control_operations WHERE id=$1',[request.operationId]);
    if(row.request_hash!==requestHash)throw new ServiceError('operation_conflict',409);
    return {operationId:row.id,challenge:row.challenge_text,expiresAt:Date.parse(row.expires_at)/1000,state:row.state};
  }
  async publicState(subjectId){
    parse(controlSubject,subjectId);
    return transaction(this.db,async db=>{
      const subject=await lockSubjectControl(db,subjectId);if(!subject)throw new ServiceError('identity_not_registered',404);
      const head=await one(db,'SELECT * FROM subject_control_heads WHERE subject_id=$1',[subjectId]);
      const recovery=await one(db,"SELECT * FROM recovery_authorizations WHERE subject_id=$1 AND status='active'",[subjectId]);
      return {subjectId,genesisProof:subject.genesis_proof,epoch:head?.epoch??0,sequence:head?.sequence??0,
        chainHead:head?.event_hash??null,authority:this.endpoint,checkedAt:this.now(),
        devices:(await db.query('SELECT device_id,key_id,public_key,epoch,scopes,status,source_event_id,revoked_at FROM device_authorizations WHERE subject_id=$1 ORDER BY device_id',[subjectId])).rows,
        recovery:recovery?{generation:recovery.generation,epoch:recovery.epoch,publicKeyPem:recovery.public_key,
          sourceEventId:recovery.source_event_id,saveDeclaredAt:recovery.save_declared_at}:null,
        recoveryReadiness:!recovery?'not-configured':recovery.save_declared_at?'registered-save-declared':'registered-awaiting-save-declaration',
        events:(await db.query('SELECT * FROM subject_control_events WHERE subject_id=$1 ORDER BY sequence',[subjectId])).rows,
        dataRecovery:'separate/not-performed'};
    });
  }
  async commit(input){
    const commit=parse(controlCommitSchema,input);
    try{return await transaction(this.db,async db=>{
      const found=await one(db,'SELECT * FROM identity_control_operations WHERE id=$1',[commit.operationId]);
      if(!found)throw new ServiceError('identity_operation_unknown',404);
      const request=found.request;
      if(request.kind==='bootstrap'){
        await verifyControlSignature(commit.controllerSignature,request.genesisProof.publicKeyPem,found.challenge_text);
        await db.query(`INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,
          [request.subjectId,request.genesisProof.publicKeyPem,JSON.stringify(request.genesisProof)]);
      }
      const subject=await lockSubjectControl(db,request.subjectId,{exclusive:true});
      if(!subject)throw new ServiceError('identity_not_registered',404);
      if((await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('partial','primary-erased')",[request.subjectId])).rows.length)
        throw new ServiceError('subject_deletion_recorded',410);
      const operation=await one(db,'SELECT * FROM identity_control_operations WHERE id=$1 FOR UPDATE',[commit.operationId]);
      if(operation.state==='committed'){
        await this.#receiptProof(db,operation,commit);
        return operation.receipt;
      }
      if(operation.state==='canceled')throw new ServiceError('identity_operation_canceled',409);
      if(Date.parse(operation.expires_at)<=this.now()*1000)throw new ServiceError('identity_challenge_expired',401);
      const head=await one(db,'SELECT * FROM subject_control_heads WHERE subject_id=$1',[request.subjectId]);
      if(request.expectedEpoch!==(head?.epoch??0))throw new ServiceError('control_epoch_changed',409);
      if(request.previousEventHash!==(head?.event_hash??null))throw new ServiceError('control_head_changed',409);
      const recovery=await one(db,"SELECT * FROM recovery_authorizations WHERE subject_id=$1 AND status='active'",[request.subjectId]);
      let signer;
      if(request.kind==='bootstrap'){
        if(head||subject.public_key!==request.genesisProof.publicKeyPem)throw new ServiceError('identity_already_upgraded',409);
        signer={publicKey:subject.public_key,keyId:controlKeyId(subject.public_key),scopes:['*']};
      }else if(request.kind==='recover'){
        if(!recovery||recovery.epoch!==head?.epoch||recovery.generation!==request.recoveryGeneration)
          throw new ServiceError('recovery_generation_consumed',409);
        signer={publicKey:recovery.public_key,keyId:controlKeyId(recovery.public_key),scopes:['*']};
      }else{
        if(!head)throw new ServiceError('identity_control_upgrade_required',409);
        signer=await currentControlKey(db,request.subjectId,{keyId:request.signerKeyId,epoch:request.expectedEpoch,scope:'manage-identity'});
      }
      if(signer.keyId!==request.signerKeyId)throw new ServiceError('identity_control_proof_invalid',401);
      await verifyControlSignature(commit.controllerSignature,signer.publicKey,operation.challenge_text);
      if(request.newDevice){
        await verifyControlSignature(commit.newDeviceProof,request.newDevice.publicKeyPem,operation.challenge_text);
        if(request.newDevice.scopes.some(s=>!signer.scopes.includes('*')&&!signer.scopes.includes(s)))
          throw new ServiceError('identity_scope_escalation',403);
        if(['bootstrap','recover'].includes(request.kind)&&!request.newDevice.scopes.includes('manage-identity'))
          throw new ServiceError('identity_manager_required',400);
      }
      if(request.kind==='set-recovery'&&request.recoveryGeneration!==(recovery?.generation??0))
        throw new ServiceError('recovery_generation_consumed',409);
      if(request.kind==='declare-recovery-saved'&&(!recovery||recovery.generation!==request.recoveryGeneration))
        throw new ServiceError('recovery_generation_consumed',409);
      if(request.nextRecoveryPublicKey){
        if(request.nextRecoveryPublicKey===request.newDevice?.publicKeyPem || request.nextRecoveryPublicKey===signer.publicKey
          ||(await db.query('SELECT 1 FROM recovery_authorizations WHERE subject_id=$1 AND public_key=$2',[request.subjectId,request.nextRecoveryPublicKey])).rows.length)
          throw new ServiceError('recovery_key_reused',409);
      }
      const acceptedAt=iso(this.now()),epoch=request.kind==='recover'?(head.epoch+1):(head?.epoch??1),sequence=(head?.sequence??0)+1;
      const event={id:request.operationId,subjectId:request.subjectId,sequence,epoch,kind:request.kind,
        previousEventHash:head?.event_hash??null,payloadText:operation.challenge_text,controllerSignature:commit.controllerSignature,
        newDeviceProof:commit.newDeviceProof??null,signerKeyId:signer.keyId,acceptedAt};
      const eventHash=controlEventHash(event);
      await db.query(`INSERT INTO subject_control_events(id,subject_id,sequence,epoch,kind,previous_event_hash,event_hash,payload_text,
        controller_signature,new_device_proof,signer_key_id,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [event.id,event.subjectId,sequence,epoch,event.kind,event.previousEventHash,eventHash,event.payloadText,event.controllerSignature,event.newDeviceProof,event.signerKeyId,acceptedAt]);
      if(request.kind==='recover'){
        await db.query("UPDATE device_authorizations SET status='revoked',revoked_at=$2 WHERE subject_id=$1 AND status='active'",[request.subjectId,acceptedAt]);
        await db.query('UPDATE bindings SET revoked_at=$2 WHERE subject_id=$1 AND revoked_at IS NULL',[request.subjectId,acceptedAt]);
        await db.query(`UPDATE access_credentials SET revoked_at=$2 WHERE binding_id IN (SELECT id FROM bindings WHERE subject_id=$1) AND revoked_at IS NULL`,[request.subjectId,acceptedAt]);
      }
      if(request.newDevice){
        await db.query(`INSERT INTO device_authorizations(device_id,subject_id,key_id,public_key,epoch,scopes,status,source_event_id)
          VALUES($1,$2,$3,$4,$5,$6,'active',$7)`,[request.newDevice.deviceId,request.subjectId,controlKeyId(request.newDevice.publicKeyPem),request.newDevice.publicKeyPem,epoch,JSON.stringify(request.newDevice.scopes),event.id]);
        if(request.kind==='bootstrap'){
          await db.query('UPDATE bindings SET device_id=$2,key_id=$3,control_epoch=$4 WHERE subject_id=$1 AND device_id IS NULL',
            [request.subjectId,request.newDevice.deviceId,signer.keyId,epoch]);
          await db.query(`UPDATE access_credentials SET device_id=$2,key_id=$3,control_epoch=$4 WHERE binding_id IN (SELECT id FROM bindings WHERE subject_id=$1) AND device_id IS NULL`,
            [request.subjectId,request.newDevice.deviceId,signer.keyId,epoch]);
        }
      }
      if(request.kind==='revoke-device'){
        const target=await one(db,"SELECT * FROM device_authorizations WHERE device_id=$1 AND subject_id=$2 AND status='active' AND epoch=$3",[request.deviceId,request.subjectId,epoch]);
        if(!target)throw new ServiceError('identity_device_not_active',409);
        if(target.scopes.includes('manage-identity')){
          const others=(await db.query("SELECT device_id FROM device_authorizations WHERE subject_id=$1 AND epoch=$2 AND status='active' AND device_id<>$3 AND scopes ? 'manage-identity'",[request.subjectId,epoch,request.deviceId])).rows;
          if(!others.length&&!recovery)throw new ServiceError('identity_last_controller',409);
        }
        await db.query("UPDATE device_authorizations SET status='revoked',revoked_at=$2 WHERE device_id=$1",[request.deviceId,acceptedAt]);
        await db.query('UPDATE bindings SET revoked_at=$2 WHERE device_id=$1 AND revoked_at IS NULL',[request.deviceId,acceptedAt]);
        await db.query('UPDATE access_credentials SET revoked_at=$2 WHERE device_id=$1 AND revoked_at IS NULL',[request.deviceId,acceptedAt]);
      }
      if(request.nextRecoveryPublicKey){
        if(recovery)await db.query('UPDATE recovery_authorizations SET status=$3 WHERE subject_id=$1 AND generation=$2',
          [request.subjectId,recovery.generation,request.kind==='recover'?'consumed':'replaced']);
        await db.query(`INSERT INTO recovery_authorizations(subject_id,generation,epoch,public_key,source_event_id,status,save_declared_at)
          VALUES($1,$2,$3,$4,$5,'active',$6)`,[request.subjectId,(recovery?.generation??0)+1,epoch,request.nextRecoveryPublicKey,event.id,request.kind==='set-recovery'?acceptedAt:null]);
      }
      if(request.kind==='declare-recovery-saved')await db.query('UPDATE recovery_authorizations SET save_declared_at=$3 WHERE subject_id=$1 AND generation=$2',[request.subjectId,recovery.generation,acceptedAt]);
      await db.query(`INSERT INTO subject_control_heads(subject_id,epoch,sequence,event_hash) VALUES($1,$2,$3,$4)
        ON CONFLICT(subject_id) DO UPDATE SET epoch=excluded.epoch,sequence=excluded.sequence,event_hash=excluded.event_hash`,[request.subjectId,epoch,sequence,eventHash]);
      const receipt={operationId:event.id,subjectId:request.subjectId,state:'committed',kind:request.kind,epoch,sequence,chainHead:eventHash,
        ...(request.newDevice?{deviceId:request.newDevice.deviceId,keyId:controlKeyId(request.newDevice.publicKeyPem)}:{}),
        ...(request.nextRecoveryPublicKey?{activeRecoveryGeneration:(recovery?.generation??0)+1}:{}),
        ...(request.kind==='recover'?{consumedRecoveryGeneration:recovery.generation,oldDeviceAccess:'revoked-on-current-authority',recoveryReadiness:'registered-awaiting-save-declaration'}:{}),
        dataRecovery:'separate/not-performed',acceptedAt};
      await db.query("UPDATE identity_control_operations SET state='committed',receipt=$2,committed_at=$3 WHERE id=$1",[event.id,JSON.stringify(receipt),acceptedAt]);
      return receipt;
    });}catch(error){if(error.code==='23505')throw new ServiceError('identity_operation_conflict',409);throw error;}
  }
  async #receiptProof(db,operation,commit){
    const event=await one(db,'SELECT * FROM subject_control_events WHERE id=$1',[operation.id]);
    // A retry must retain the original proof; a new device can also query with its signed challenge.
    if(event.controller_signature===commit.controllerSignature&&event.new_device_proof===(commit.newDeviceProof??null))return;
    if(operation.request.newDevice&&commit.newDeviceProof){await verifyControlSignature(commit.newDeviceProof,operation.request.newDevice.publicKeyPem,operation.challenge_text);return;}
    throw new ServiceError('identity_control_proof_invalid',401);
  }
  async status(input){
    const commit=parse(controlCommitSchema,input);
    const operation=await one(this.db,'SELECT * FROM identity_control_operations WHERE id=$1',[commit.operationId]);
    if(!operation)throw new ServiceError('identity_operation_unknown',404);
    if(operation.state==='committed'){await this.#receiptProof(this.db,operation,commit);return operation.receipt;}
    if(operation.request.newDevice&&commit.newDeviceProof)await verifyControlSignature(commit.newDeviceProof,operation.request.newDevice.publicKeyPem,operation.challenge_text);
    else await this.#currentOperationProof(this.db,operation,commit.controllerSignature);
    return {operationId:operation.id,subjectId:operation.subject_id,state:operation.state==='requested'&&Date.parse(operation.expires_at)<=this.now()*1000?'expired':operation.state};
  }
  async #currentOperationProof(db,operation,signature){
    const request=operation.request;
    let key;
    if(request.kind==='bootstrap')key=request.genesisProof.publicKeyPem;
    else if(request.kind==='recover')key=(await one(db,'SELECT public_key FROM recovery_authorizations WHERE subject_id=$1 AND generation=$2',[request.subjectId,request.recoveryGeneration]))?.public_key;
    else key=(await currentControlKey(db,request.subjectId,{keyId:request.signerKeyId,epoch:request.expectedEpoch,scope:'manage-identity'})).publicKey;
    await verifyControlSignature(signature,key,operation.challenge_text);
  }
  async cancel(input){
    const commit=parse(controlCommitSchema,input);
    return transaction(this.db,async db=>{
      const initial=await one(db,'SELECT * FROM identity_control_operations WHERE id=$1',[commit.operationId]);
      if(!initial)throw new ServiceError('identity_operation_unknown',404);
      await lockSubjectControl(db,initial.subject_id);
      const operation=await one(db,'SELECT * FROM identity_control_operations WHERE id=$1 FOR UPDATE',[commit.operationId]);
      if(operation.state==='committed'){await this.#receiptProof(db,operation,commit);return operation.receipt;}
      await this.#currentOperationProof(db,operation,commit.controllerSignature);
      await db.query("UPDATE identity_control_operations SET state='canceled' WHERE id=$1",[operation.id]);
      return {operationId:operation.id,subjectId:operation.subject_id,state:'canceled'};
    });
  }
}
