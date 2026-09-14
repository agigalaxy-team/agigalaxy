export const verificationRecordRepository=db=>({
  async peek(id){return (await db.query('SELECT * FROM verification_objects WHERE id=$1',[id])).rows[0];},
  async ensure(data,type,subjectId){await db.query(`INSERT INTO verification_objects(id,object_type,case_id,subject_id,version,state)
    VALUES($1,$2,$3,$4,0,'active') ON CONFLICT(id) DO NOTHING`,[data.id,type,data.caseId,subjectId]);},
  async object(id,write=false){return (await db.query(`SELECT * FROM verification_objects WHERE id=$1 ${write?'FOR UPDATE':'FOR SHARE'}`,[id])).rows[0];},
  async event(id,version){return (await db.query('SELECT * FROM verification_events WHERE object_id=$1 AND version=$2',[id,version])).rows[0];},
  async operation(id){return (await db.query('SELECT * FROM verification_events WHERE operation_id=$1',[id])).rows[0];},
  async append(data,consentId,payloadJson,hash,context){await db.query(`INSERT INTO verification_events(operation_id,object_id,version,consent_id,payload,payload_text,payload_hash,context)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)`,[data.operationId,data.id,data.expectedVersion+1,consentId,payloadJson,payloadJson,hash,JSON.stringify(context)]);
    await db.query('UPDATE verification_objects SET version=$2,state=$3 WHERE id=$1',[data.id,data.expectedVersion+1,data.kind==='revoke'?'revoked':'active']);},
  async dependencies(data){const refs=data.kind==='verification'?[data.target,...data.evidenceRefs.map(x=>({type:'evidence',...x}))]:[];
    for(const ref of refs)await db.query(`INSERT INTO verification_dependencies(object_id,object_version,target_type,target_id,target_version)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[data.id,data.expectedVersion+1,ref.type,ref.id,ref.version]);},
  async audit(actor,data,consentId,authorization){
    const result=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,
      consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
      SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'evidence',c.id,b.id,$5,$4,b.scopes,$6::jsonb,
        cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
      FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
      JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
      WHERE c.id=$8 AND c.subject_id=$1 RETURNING sequence`,[actor.subjectId,`verification-record.${data.kind}`,data.id,data.operationId,
      actor.httpRequestId??null,JSON.stringify(authorization.credentialScopes),authorization.callerBindingId,consentId]);
    if(result.rows.length!==1)throw new Error('Verification audit context unavailable');
  }
});
