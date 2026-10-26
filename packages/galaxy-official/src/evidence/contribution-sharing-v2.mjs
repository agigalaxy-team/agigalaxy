import {contributionStatusSchema,contributionOwnedSourcesSchema,contributionPreviewSchema,contributionPublicationSchema,contributionProjectionReadSchema,contributionProjectionFields} from "../shared/contribution-sharing-v2-schema.mjs";
import {canReadProjection} from "../domain/consent-policy.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {digest} from "../shared/digest.mjs";
import {transaction} from "../infrastructure/database.mjs";
import {hasTaskMaterials,hasTaskText} from "../shared/task-material-v1-schema.mjs";
const rule=(ok,code,status=403)=>{if(!ok)throw new ServiceError(code,status);};
const taskKinds=new Set(['task-created','participation-proposed','confirm','propose-scope','confirm-scope','deliver','accept','withdraw','cancel','close',
  'dispute','propose-resolution','confirm-resolution','requester-feedback']);
const absent=e=>e instanceof ServiceError&&[403,404,409,422].includes(e.status);
export class ContributionSharingV2Service{
  constructor(access,consents,{taskMaterials=null}={}){Object.assign(this,{access,consents,taskMaterials});}
  status(actor,input){const parsed=contributionStatusSchema.safeParse(input);rule(parsed.success,'invalid_contribution_reference',400);
    return this.access.runAuthorized(actor,'history',async db=>{
      const row=(await db.query('SELECT * FROM contribution_publications WHERE id=$1 AND subject_id=$2',[parsed.data.publicationId,actor.subjectId])).rows[0];
      if(!row)return{publicationId:parsed.data.publicationId,state:'absent'};
      let state=row.revoked_at?'revoked':'published',sourceUnavailable=0;
      const payload=row.payload_text?contributionPublicationSchema.parse(JSON.parse(row.payload_text)):null;
      if(!payload)state='source-unavailable';
      else if(state!=='revoked'){
        if(Date.parse(payload.expiresAt)<=this.access.now()*1000)state='expired';
        try{const grant=await this.consents.require(db,{id:row.consent_id,subjectId:actor.subjectId,objectId:row.id,action:'contribution.publish',recipient:this.access.endpoint,payloadJson:row.payload_text});
          if(grant.currentVisibility?.deletionPending)state='source-unavailable';
        }catch(error){if(!absent(error))throw error;state='authorization-unavailable';}
        for(const ref of payload.sourceRefs)try{await this.sourceGrantWithin(db,ref.kind,await this.sourceWithin(db,ref));}
          catch(error){if(!absent(error))throw error;sourceUnavailable++;}
        if(sourceUnavailable&&state==='published')state='source-unavailable';
      }
      return{publicationId:row.id,state,payloadHash:row.payload_hash,sourceRefs:payload?.sourceRefs??[],purposes:payload?.purposes??[],expiresAt:payload?.expiresAt??null,
        revokeOperationId:row.revoke_id,revokePayloadHash:row.revoke_payload_hash,sourceUnavailable,originalPermissionsChanged:false};
    });
  }
  ownedSources(actor,input){const parsed=contributionOwnedSourcesSchema.safeParse(input);rule(parsed.success,'invalid_contribution_source_query',400);
    const q=parsed.data,table=q.kind==='case-event'?'case_events':'task_events',parent=q.kind==='case-event'?'case_id':'task_id';
    return this.access.runAuthorized(actor,'history',async db=>{
      const rows=(await db.query(`SELECT * FROM ${table} WHERE ${parent}=$1 AND subject_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,[q.parentId,actor.subjectId,q.after??null,q.limit+1])).rows;
      const items=[];for(const row of rows.slice(0,q.limit))try{
        const source={kind:q.kind,id:row.id,eventVersion:1,payloadHash:row.payload_hash};
        const current=await this.sourceWithin(db,source);await this.sourceGrantWithin(db,q.kind,current);
        items.push({source,eventType:current.kind,availableFields:contributionProjectionFields,publication:'not-published-by-enumeration'});
      }catch(error){if(!absent(error))throw error;}
      return{items,nextAfter:rows.length>q.limit?rows[q.limit-1].id:null,coverage:'current-own-publishable-events-only',originalTextIncluded:false};
    });
  }
  async sourceWithin(db,ref){
    const table=ref.kind==='case-event'?'case_events':'task_events';
    const located=(await db.query(`SELECT * FROM ${table} WHERE id=$1`,[ref.id])).rows[0];rule(located,'contribution_source_unavailable',404);
    if(ref.kind==='case-event')await db.query('SELECT id FROM cases WHERE id=$1 FOR SHARE',[located.case_id]);
    else await db.query('SELECT id FROM task_requests WHERE id=$1 FOR SHARE',[located.task_id]);
    // The owning Task/Case lock serializes deletion. Event text is immutable to
    // the API role; a row lock here would require unnecessary UPDATE privilege.
    const row=(await db.query(`SELECT * FROM ${table} WHERE id=$1`,[ref.id])).rows[0];
    rule(row?.payload_text&&row.payload_hash===ref.payloadHash,'contribution_source_unavailable',404);
    if(ref.kind==='task-event')rule(taskKinds.has(row.kind),'contribution_source_kind_not_publishable',422);
    return row;
  }
  async sourceGrantWithin(db,kind,row){
    rule(row?.payload_text,'contribution_source_unavailable',404);
    const grant=await this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,objectId:row.id,
      action:kind==='case-event'?'case.teaser.publish':'assistance.publish',recipient:this.access.endpoint,payloadJson:row.payload_text});
    rule(!grant.currentVisibility?.deletionPending,'contribution_source_unavailable',404);
    if(kind==='case-event'){const parent=(await db.query('SELECT state FROM cases WHERE id=$1 FOR SHARE',[row.case_id])).rows[0];rule(parent&&parent.state!=='withdrawn','contribution_source_unavailable',404);}
    else{const parent=(await db.query('SELECT snapshot FROM task_requests WHERE id=$1 FOR SHARE',[row.task_id])).rows[0];rule(parent&&!parent.snapshot.contentDeleted,'contribution_source_unavailable',404);}
    return grant;
  }
  async authorizeWithin(db,actor,kind,row,{purpose='honor'}={}){
    const original=await this.sourceGrantWithin(db,kind,row);
    if(canReadProjection(original,{viewerId:actor?.subjectId??null,now:this.access.now()}))return{original,publicationIds:[],fields:contributionProjectionFields};
    const ref={kind,id:row.id,eventVersion:1,payloadHash:row.payload_hash};
    const rows=(await db.query(`SELECT p.*,b.expires_at AS grant_binding_expires FROM contribution_publications p
      JOIN consents c ON c.id=p.consent_id AND c.subject_id=p.subject_id JOIN bindings b ON b.id=c.binding_id
      WHERE p.subject_id=$1 AND p.source_refs @> $2::jsonb AND p.revoked_at IS NULL ORDER BY p.id FOR SHARE OF p`,
      [row.subject_id,JSON.stringify([ref])])).rows;
    const publicationIds=[],fields=new Set(),fieldExpiresAt={};
    for(const published of rows)try{
      rule(published.payload_text,'contribution_publication_unavailable',404);
      const payload=contributionPublicationSchema.parse(JSON.parse(published.payload_text));
      rule(payload.kind==='publish'&&payload.purposes.includes(purpose)&&Date.parse(payload.expiresAt)>this.access.now()*1000,'contribution_publication_unavailable',404);
      const grant=await this.consents.require(db,{id:published.consent_id,subjectId:row.subject_id,objectId:published.id,action:'contribution.publish',
        recipient:this.access.endpoint,payloadJson:published.payload_text});
      rule(!grant.currentVisibility?.deletionPending&&grant.visibility==='Public'&&canReadProjection(grant,{viewerId:actor?.subjectId??null,now:this.access.now()}),'contribution_publication_unavailable',404);
      const selected=payload.sourceRefs.find(r=>r.kind===kind&&r.id===row.id&&r.payloadHash===row.payload_hash);
      rule(selected,'contribution_publication_unavailable',404);
      const expiresAt=Math.min(Date.parse(payload.expiresAt)/1000,grant.expiresAt,Date.parse(published.grant_binding_expires)/1000);
      publicationIds.push(published.id);for(const field of selected.fields){fields.add(field);fieldExpiresAt[field]=Math.max(fieldExpiresAt[field]??0,expiresAt);}
    }catch(error){if(!absent(error))throw error;}
    if(publicationIds.length)return{original,publicationIds,fields:[...fields],fieldExpiresAt};
    throw new ServiceError('contribution_source_unavailable',404);
  }
  project(row,fields){
    const parsed=JSON.parse(row.payload_text),event=parsed.event??parsed;
    const values={eventType:row.kind,actorId:row.subject_id,role:event.role??null,interventionTypes:event.types??null,scopeVersion:event.scopeVersion??null,
      reportedOutcome:event.reportedOutcome??null,feedback:event.kind==='requester-feedback'?{descriptionClarity:event.descriptionClarity,scopeMatched:event.scopeMatched}:null,
      scope:event.agreedScope??null,title:event.title??null,summary:event.summary??event.reason??event.note??null,time:row.created_at,
      caseId:row.case_id??null,taskId:row.task_id??event.taskId??null,participationId:row.participation_id??event.participationId??null};
    return Object.fromEntries(fields.map(field=>[field,values[field]]));
  }
  async projectWithin(db,actor,row,fields,{fieldExpiresAt={}}={}){
    const projection=this.project(row,fields),selectedFields=fields.filter(field=>field==='title'||field==='summary');
    if(row.kind!=='task-created'||!selectedFields.length)return projection;
    const request=JSON.parse(row.payload_text);
    if(!hasTaskMaterials(request)&&!hasTaskText(request))return projection;
    rule(this.taskMaterials,'task_material_reader_unavailable',503);
    const task=(await db.query('SELECT id,requester_id,root_event_id,snapshot FROM task_requests WHERE id=$1 AND root_event_id=$2',[row.task_id,row.id])).rows[0];
    rule(task&&!task.snapshot.contentDeleted,'contribution_source_unavailable',404);
    const {textView}=await this.taskMaterials.projectWithin(db,actor,task,{selectedFields});
    for(const field of selectedFields){const view=textView.fields[field],expiresAt=fieldExpiresAt[field];
      if(view.availableUntil!==undefined&&expiresAt!==undefined)view.availableUntil=Math.min(view.availableUntil,expiresAt);
      projection[field]=view.text;
    }
    // Only the already selected fields have current text metadata. This does
    // not reveal an unselected Task ID, material locator or original request.
    return {...projection,textView};
  }
  reference(row,kind,permission){return permission.publicationIds.length
    ?{publicationId:permission.publicationIds[0],sourceKey:digest(JSON.stringify([kind,row.id,row.payload_hash]))}
    :{kind,id:row.id,eventVersion:1,payloadHash:row.payload_hash};}
  preview(actor,input){const parsed=contributionPreviewSchema.safeParse(input);rule(parsed.success,'invalid_contribution_preview',400);
    return this.access.runAuthorized(actor,'history',async db=>{const items=[];for(const ref of parsed.data.sourceRefs){const row=await this.sourceWithin(db,ref);
      await this.sourceGrantWithin(db,ref.kind,row);rule(row.subject_id===actor.subjectId,'contribution_source_author_required');
      const{fields,...source}=ref;items.push({ref:source,projection:await this.projectWithin(db,actor,row,fields),publication:'not-published-by-preview'});}
      return{items,purposes:parsed.data.purposes,publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged',originalPermissionsChanged:false,
        derivedDisclosure:'The selected purposes may attribute and count this author’s currently valid scoped contribution; no unselected text or other-party identity is disclosed.'};});}
  readProjection(actor,input){const parsed=contributionProjectionReadSchema.safeParse(input);rule(parsed.success,'invalid_contribution_reference',400);
    const read=async db=>{let ref=parsed.data.source;
      if(!ref){const publication=(await db.query('SELECT payload_text FROM contribution_publications WHERE id=$1',[parsed.data.publicationId])).rows[0];rule(publication?.payload_text,'contribution_source_unavailable',404);
        const p=contributionPublicationSchema.parse(JSON.parse(publication.payload_text)),selected=p.kind==='publish'&&p.sourceRefs.find(r=>digest(JSON.stringify([r.kind,r.id,r.payloadHash]))===parsed.data.sourceKey);
        rule(selected,'contribution_source_unavailable',404);const{fields:_fields,...source}=selected;ref=source;}
      const row=await this.sourceWithin(db,ref),permission=await this.authorizeWithin(db,actor,ref.kind,row,{purpose:parsed.data.purpose});
      return{ref:this.reference(row,ref.kind,permission),projection:await this.projectWithin(db,actor,row,permission.fields,permission),publicationIds:permission.publicationIds,
        sourceState:'currently-authorized-projection',originalTextAccessGranted:false,capabilityVerified:false};};
    return actor?this.access.runAuthorized(actor,'history',read):transaction(this.access.db,read);
  }
  async submit(actor,input){let payload;try{rule(typeof input?.payloadJson==='string'&&Buffer.byteLength(input.payloadJson)<=48000,'invalid_contribution_publication',400);
    payload=contributionPublicationSchema.parse(JSON.parse(input.payloadJson));}catch{throw new ServiceError('invalid_contribution_publication',400);}
    return this.access.runResourceWrite(actor,'history',{control:payload.kind==='revoke'},async(db,authorization)=>{
      const grant=await this.consents.require(db,{id:input.consentId,subjectId:actor.subjectId,objectId:payload.id,action:'contribution.publish',recipient:this.access.endpoint,payloadJson:input.payloadJson});
      if(payload.kind==='publish'){
        rule(grant.visibility==='Public'&&grant.purpose==='public-profile'&&Date.parse(payload.expiresAt)>this.access.now()*1000,'contribution_publication_scope_required');
        for(const ref of payload.sourceRefs){const source=await this.sourceWithin(db,ref);await this.sourceGrantWithin(db,ref.kind,source);rule(source.subject_id===actor.subjectId,'contribution_source_author_required');}
        const prior=(await db.query('SELECT * FROM contribution_publications WHERE id=$1',[payload.id])).rows[0];
        if(prior)rule(prior.subject_id===actor.subjectId&&prior.payload_hash===digest(input.payloadJson)&&prior.consent_id===input.consentId,'contribution_publication_conflict',409);
        else await db.query('INSERT INTO contribution_publications(id,subject_id,consent_id,source_refs,payload_text,payload_hash) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
          [payload.id,actor.subjectId,input.consentId,JSON.stringify(payload.sourceRefs),input.payloadJson,digest(input.payloadJson)]);
      }else{
        const prior=(await db.query('SELECT * FROM contribution_publications WHERE id=$1 AND subject_id=$2 FOR UPDATE',[payload.publicationId,actor.subjectId])).rows[0];
        rule(prior?.payload_text,'contribution_publication_unavailable',404);
        if(prior.revoked_at)rule(prior.revoke_id===payload.id&&prior.revoke_consent_id===input.consentId&&prior.revoke_payload_hash===digest(input.payloadJson),'contribution_publication_conflict',409);
        else await db.query('UPDATE contribution_publications SET revoked_at=$2,revoke_id=$3,revoke_consent_id=$4,revoke_payload_text=$5,revoke_payload_hash=$6 WHERE id=$1',
          [payload.publicationId,new Date(this.access.now()*1000).toISOString(),payload.id,input.consentId,input.payloadJson,digest(input.payloadJson)]);
      }
      await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
        SELECT $1,$2,$3,$3,'accepted',1,ch.payload->>'installationId',b.audience,'history',c.id,b.id,$4,$3,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
        FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
        WHERE c.id=$7 AND c.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action=$2 AND request_id=$3)`,
        [actor.subjectId,`contribution.${payload.kind}`,payload.id,actor.httpRequestId??null,JSON.stringify(authorization.credentialScopes),authorization.callerBindingId,input.consentId]);
      const current=(await db.query('SELECT revoked_at FROM contribution_publications WHERE id=$1',[payload.publicationId??payload.id])).rows[0];
      return{operationId:payload.id,publicationId:payload.publicationId??payload.id,state:current.revoked_at?'revoked':'published',originalPermissionsChanged:false,
        publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged',otherPublicationGrantsRevoked:false};
    });
  }
}
