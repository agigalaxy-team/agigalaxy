import {hubEventSchema,hubReadSchema,hubQuerySchema,hubMembershipQuerySchema,hubReceiptSchema,hubIntakeQuerySchema} from './shared/hubs-v2-schema.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import {canReadProjection} from './consents.mjs';
import {transaction} from './database.mjs';

const requireValue=(yes,code='hub_unavailable',status=404)=>{if(!yes)throw new ServiceError(code,status);};
const parsed=(schema,input)=>{const p=schema.safeParse(input);requireValue(p.success,'invalid_hub_request',400);return p.data;};
const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];
const event=row=>row?.payload_text?JSON.parse(row.payload_text):null;
const controlKinds=new Set(['exit','decline','remove','suspend','intake-close']);
const flags={identityChanged:false,taskAccessGranted:false,capabilityVerified:false,autonomousDomainVerified:false,relayEnabled:false};
export class HubServiceV2{
  constructor(access,consents,builders){Object.assign(this,{access,consents,builders});this.now=access.now;this.endpoint=access.endpoint;}
  specification(){return{profile:'galaxy-hub-charter/1',membership:'controlled-invitation-and-exact-scope',
    scopeMeaning:{'approved-proof-query':'eligible for separately authorized read-only peering','member-updates':'read own current Hub membership updates; no push promise'},
    compatibilityAuthority:'operator-declared; reports retain their own scope',...flags};}
  read(actor,fn){return actor?this.access.runAuthorized(actor,'builders',fn):transaction(this.access.db,fn);}
  async head(db,id,lock='SHARE'){
    const h=await one(db,`SELECT * FROM hub_heads_v2 WHERE id=$1 FOR ${lock}`,[id]);requireValue(h);return h;
  }
  async grant(db,row){requireValue(row?.payload_text);const g=await this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,
    action:'hub.publish',objectId:row.id,recipient:this.endpoint,payloadJson:row.payload_text});
    requireValue(!g.currentVisibility?.deletionPending);return g;}
  async readable(db,actor,row){try{return canReadProjection(await this.grant(db,row),{viewerId:actor?.subjectId??null,now:this.now()});}
    catch(e){if(e instanceof ServiceError)return false;throw e;}}
  async charterWithin(db,actor,head,version=head.version){
    const row=await one(db,"SELECT * FROM hub_events_v2 WHERE hub_id=$1 AND charter_version=$2 AND kind='charter'",[head.id,version]);
    requireValue(await this.readable(db,actor,row));return{row,payload:event(row)};
  }
  async currentWithin(db,actor,hubId){const head=await this.head(db,hubId),c=await this.charterWithin(db,actor,head);
    const loaded=await this.builders.load(db,hubId),current=await this.builders.current(db,actor,loaded),maintenance=this.builders.maintenance(loaded.rows);
    requireValue(head.state==='active'&&!maintenance.delisted&&!maintenance.securityIssue&&current.row.id===c.payload.declarationId
      &&current.row.payload_hash===c.payload.declarationHash,'hub_current_scope_unavailable',409);
    return{head,...c};}
  async readWithin(db,actor,input){const q=parsed(hubReadSchema,input),head=await this.head(db,q.hubId),c=await this.charterWithin(db,actor,head,q.version);
    let currentState=head.state,reports=[];
    try{const b=await this.builders.load(db,head.id),d=await this.builders.current(db,actor,b),m=this.builders.maintenance(b.rows);
      if(d.row.id!==c.payload.declarationId||d.row.payload_hash!==c.payload.declarationHash)currentState='declaration-changed';
      if(m.delisted||m.securityIssue)currentState='builder-unavailable';
      if(this.builders.v2)reports=(await this.builders.v2.readWithin(db,actor,{builderId:head.id})).reports;
    }catch(e){if(!(e instanceof ServiceError))throw e;currentState='declaration-unavailable';}
    const claims={};for(const [key,value]of Object.entries(c.payload.charter))if(value&&typeof value==='object'&&'status'in value){
      const report=value.reportRef&&reports.find(r=>r.id===value.reportRef.eventId);
      const reportRow=report&&await one(db,'SELECT payload_hash FROM builder_events WHERE id=$1',[report.id]);
      const check=report?.checks.find(check=>check.action===value.reportRef.action);
      claims[key]={...value,currentState:value.status!=='reported-tested'?value.status:report?.validity==='current'&&reportRow?.payload_hash===value.reportRef.payloadHash&&check?'reported-'+check.status:'report-unavailable',
        ...(report?{reportAuthority:report.authority,independentExecutionVerified:false}:{}),capabilityVerified:false};
    }
    return{hubId:head.id,ownerId:head.owner_id,version:c.row.charter_version,latestVersion:head.version,
      state:c.row.charter_version===head.version?currentState:'historical-version',charter:c.payload.charter,claims,
      charterEventId:c.row.id,charterHash:c.row.payload_hash,declarationId:c.payload.declarationId,declarationHash:c.payload.declarationHash,
      checkedAt:this.now(),...flags};
  }
  get(actor,input){return this.read(actor,db=>this.readWithin(db,actor,input));}
  manage(actor,input){const q=parsed(hubReadSchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    const declaration=await this.builders.managementWithin(db,actor,q.hubId),head=await one(db,'SELECT * FROM hub_heads_v2 WHERE id=$1',[q.hubId]);
    let current=null;if(head)try{current=await this.readWithin(db,actor,{hubId:q.hubId});}catch(e){if(!(e instanceof ServiceError))throw e;}
    return{hubId:q.hubId,ownerId:actor.subjectId,latestVersion:head?.version??0,state:head?.state??'charter-not-created',current,declaration,...flags};});}
  async query(actor,input={}){const q=parsed(hubQuerySchema,input);requireValue(q.view==='public'||actor,'identity_required',401);
    return this.read(actor,async db=>{const rows=(await db.query(`SELECT h.id FROM hub_heads_v2 h WHERE ($1::uuid IS NULL OR h.id>$1)
      AND ($2='public' OR $2='owned' AND h.owner_id=$3 OR $2='joined' AND EXISTS(SELECT 1 FROM hub_memberships_v2 m WHERE m.hub_id=h.id AND m.subject_id=$3))
      ORDER BY h.id LIMIT $4`,[q.after??null,q.view,actor?.subjectId??null,q.limit+1])).rows,items=[];
      for(const row of rows.slice(0,q.limit))try{items.push(await this.readWithin(db,q.view==='public'?null:actor,{hubId:row.id}));}
      catch(e){if(!(e instanceof ServiceError))throw e;}
      return{items,nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,coverage:'current-authorized-charters',...flags};});}
  async membershipWithin(db,actor,head,id){const m=await one(db,'SELECT * FROM hub_memberships_v2 WHERE id=$1 AND hub_id=$2 FOR SHARE',[id,head.id]);
    requireValue(m&&(actor?.subjectId===m.subject_id||actor?.subjectId===head.owner_id));
    const invite=await one(db,'SELECT * FROM hub_events_v2 WHERE id=$1',[m.invite_id]),decision=m.decision_id&&await one(db,'SELECT * FROM hub_events_v2 WHERE id=$1',[m.decision_id]);
    const inviteValid=await this.readable(db,actor,invite),decisionValid=decision&&await this.readable(db,actor,decision);
    const base={membershipId:m.id,hubId:m.hub_id,memberId:m.subject_id,version:m.version,charterVersion:m.charter_version,state:m.state,
      expiresAt:Number(m.expires_at),scopes:inviteValid?m.scopes:[],...flags};
    if(['declined','exited','removed'].includes(m.state))return{...base,authorization:'inactive'};
    let charterCurrent=false;try{await this.currentWithin(db,actor,head.id);charterCurrent=head.version===m.charter_version;}catch(e){if(!(e instanceof ServiceError))throw e;}
    return{...base,authorization:!inviteValid||m.state==='active'&&!decisionValid?'permission-unavailable':m.expires_at<=this.now()?'expired'
      :!charterCurrent?'charter-reconfirmation-required':m.state==='active'?'active':'awaiting-member-confirmation'};
  }
  async members(actor,input){const q=parsed(hubMembershipQuerySchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    const h=await this.head(db,q.hubId),rows=(await db.query(`SELECT id FROM hub_memberships_v2 WHERE hub_id=$1 AND ($2::uuid IS NULL OR id>$2)
      AND ($3=$4 OR subject_id=$3) ORDER BY id LIMIT $5`,[h.id,q.after??null,actor.subjectId,h.owner_id,q.limit+1])).rows;
    const items=[];for(const r of rows.slice(0,q.limit))items.push(await this.membershipWithin(db,actor,h,r.id));
    return{items,nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,scope:actor.subjectId===h.owner_id?'operator-memberships':'own-memberships'};});}
  async requireMemberWithin(db,actor,hubId,scope){const {head}=await this.currentWithin(db,actor,hubId);
    if(actor.subjectId===head.owner_id)return{head,role:'operator'};
    const m=await one(db,"SELECT id FROM hub_memberships_v2 WHERE hub_id=$1 AND subject_id=$2 AND state='active'",[hubId,actor.subjectId]);
    requireValue(m,'hub_scope_unavailable',403);const view=await this.membershipWithin(db,actor,head,m.id);
    requireValue(view.authorization==='active'&&view.scopes.includes(scope),'hub_scope_unavailable',403);return{head,membership:view};}
  async audit(db,actor,row,a){const r=await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
    context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
    SELECT $1,'hub.event',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'builders',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
    FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
    JOIN bindings cb ON cb.id=$5 AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
    WHERE c.id=$6 AND c.subject_id=$1 RETURNING sequence`,[actor.subjectId,row.id,actor.httpRequestId??null,JSON.stringify(a.credentialScopes),a.callerBindingId,row.consent_id]);
    requireValue(r.rows.length===1,'hub_audit_unavailable',500);}
  async submit(actor,{consentId,payloadJson}){
    let e;try{requireValue(typeof payloadJson==='string'&&Buffer.byteLength(payloadJson)<=48000);e=hubEventSchema.parse(JSON.parse(payloadJson));}
    catch{throw new ServiceError('invalid_hub_event',400);}
    return this.access.runResourceWrite(actor,'builders',{control:controlKinds.has(e.kind)},async(db,a)=>{
      const row={id:e.id,subject_id:actor.subjectId,consent_id:consentId,payload_text:payloadJson,payload_hash:digest(payloadJson)},grant=await this.grant(db,row);
      const prior=await one(db,'SELECT * FROM hub_events_v2 WHERE id=$1',[e.id]);
      if(prior){requireValue(prior.subject_id===actor.subjectId&&prior.consent_id===consentId&&prior.payload_hash===row.payload_hash,'hub_event_conflict',409);return this.eventReceipt(prior);}
      if(e.kind==='charter'&&e.expectedVersion===0){const b=await this.builders.load(db,e.hubId);
        requireValue(b.parent.type==='hub'&&b.parent.owner_id===actor.subjectId,'hub_operator_required',403);
        await db.query('INSERT INTO hub_heads_v2(id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.hubId,actor.subjectId]);}
      const head=await this.head(db,e.hubId,'UPDATE'),owner=actor.subjectId===head.owner_id;
      let objectId=null,objectVersion,cv=null;
      const pair=(other)=>requireValue(grant.visibility==='Private'&&grant.viewers.length===1&&grant.viewers[0]===other,'hub_private_recipient_required',403);
      if(e.kind==='charter'){
        requireValue(owner,'hub_operator_required',403);requireValue(head.version===e.expectedVersion&&head.version<1000,'hub_version_conflict',409);
        const b=await this.builders.load(db,e.hubId),d=await this.builders.current(db,actor,b);
        requireValue(d.row.id===e.declarationId&&d.row.payload_hash===e.declarationHash,'hub_declaration_changed',409);
        requireValue(grant.visibility===d.grant.visibility&&JSON.stringify([...grant.viewers].sort())===JSON.stringify([...d.grant.viewers].sort()),'hub_visibility_mismatch',403);
        for(const clause of Object.values(e.charter))if(clause&&typeof clause==='object'&&'status'in clause){requireValue(clause.asOf<=this.now(),'hub_future_claim',400);
          if(clause.reportRef){const r=await one(db,"SELECT * FROM builder_events WHERE id=$1 AND builder_id=$2 AND kind='scope-report'",[clause.reportRef.eventId,e.hubId]);
            requireValue(r?.payload_hash===clause.reportRef.payloadHash&&await this.builders.v2?.permitted(db,actor,r),'hub_report_unavailable',409);
            requireValue(JSON.parse(r.payload_text).checks?.some(check=>check.action===clause.reportRef.action),'hub_report_action_unavailable',409);
            if(grant.visibility==='Public')requireValue(await this.builders.v2.permitted(db,null,r),'hub_report_not_public',403);}}
        objectVersion=cv=head.version+1;
      }else if(e.kind==='invite'){
        requireValue(owner&&e.memberId!==actor.subjectId,'hub_operator_required',403);pair(e.memberId);
        const c=await this.currentWithin(db,actor,e.hubId),charterGrant=await this.grant(db,c.row);
        requireValue(canReadProjection(charterGrant,{viewerId:e.memberId,now:this.now()}),'hub_charter_not_visible_to_invitee',403);
        requireValue(e.charterVersion===head.version&&e.scopes.every(s=>c.payload.charter.offeredScopes.includes(s)),'hub_charter_changed',409);
        requireValue(e.expiresAt>this.now()&&e.expiresAt<=Math.min(grant.expiresAt,this.now()+2592000),'hub_invitation_expiry',400);
        requireValue(await one(db,'SELECT id FROM subjects WHERE id=$1',[e.memberId]),'hub_invitee_unavailable',404);
        requireValue(!await one(db,"SELECT id FROM hub_memberships_v2 WHERE id=$1 OR (hub_id=$2 AND subject_id=$3 AND state IN ('invited','active'))",[e.membershipId,e.hubId,e.memberId]),'hub_membership_exists',409);
        objectId=e.membershipId;objectVersion=1;cv=e.charterVersion;
      }else if(['accept','decline','exit','remove'].includes(e.kind)){
        const m=await one(db,'SELECT * FROM hub_memberships_v2 WHERE id=$1 AND hub_id=$2 FOR UPDATE',[e.membershipId,e.hubId]);
        requireValue(m,'hub_membership_unavailable',404);requireValue(e.kind==='remove'?owner:actor.subjectId===m.subject_id,'hub_member_required',403);
        pair(owner?m.subject_id:head.owner_id);requireValue(e.expectedVersion===m.version&&e.charterVersion===m.charter_version,'hub_membership_version_conflict',409);
        if(e.kind==='accept'){
          const view=await this.membershipWithin(db,actor,head,m.id);requireValue(m.state==='invited'&&view.authorization==='awaiting-member-confirmation','hub_invitation_unavailable',409);
          requireValue(e.acceptedScopes?.length&&e.acceptedScopes.every(s=>m.scopes.includes(s)),'hub_scope_expansion',403);
        }else{requireValue(!e.acceptedScopes,'hub_unexpected_scope',400);requireValue(e.kind==='decline'?m.state==='invited':['invited','active'].includes(m.state),'hub_transition_denied',409);}
        objectId=m.id;objectVersion=m.version+1;cv=m.charter_version;
      }else if(['suspend','resume'].includes(e.kind)){
        requireValue(owner,'hub_operator_required',403);requireValue(grant.visibility==='Private'&&!grant.viewers.length,'hub_private_operator_required',403);
        requireValue(e.expectedVersion===head.version&&head.state===(e.kind==='suspend'?'active':'suspended'),'hub_transition_denied',409);
        if(e.kind==='resume'){await this.charterWithin(db,actor,head);const b=await this.builders.load(db,e.hubId);await this.builders.current(db,actor,b);}
        objectVersion=head.version;
      }else{
        objectId=e.threadId;
        if(e.kind==='intake-open'){
          requireValue(!owner,'hub_member_required',403);await this.charterWithin(db,actor,head);pair(head.owner_id);
          // Any authenticated prospective member can ask about this readable
          // charter; joining is not a prerequisite to reporting a problem.
          requireValue(!await one(db,'SELECT id FROM hub_intake_v2 WHERE id=$1',[e.threadId]),'hub_intake_exists',409);objectVersion=1;
        }else{const t=await one(db,'SELECT * FROM hub_intake_v2 WHERE id=$1 AND hub_id=$2 FOR UPDATE',[e.threadId,e.hubId]);
          requireValue(t&&(owner||actor.subjectId===t.subject_id),'hub_intake_unavailable',404);pair(owner?t.subject_id:head.owner_id);
          requireValue(t.state==='open'&&t.version===e.expectedVersion&&t.expires_at>this.now(),'hub_intake_version_conflict',409);objectVersion=t.version+1;}
      }
      Object.assign(row,{hub_id:e.hubId,kind:e.kind,object_id:objectId,object_version:objectVersion,charter_version:cv,received_at:this.now()});
      await db.query('INSERT INTO hub_events_v2(id,hub_id,subject_id,kind,charter_version,object_id,object_version,consent_id,payload_text,payload_hash,received_at,intake_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [row.id,row.hub_id,row.subject_id,row.kind,cv,objectId,objectVersion,consentId,payloadJson,row.payload_hash,row.received_at,e.kind.startsWith('intake-')?objectId:null]);
      if(e.kind==='charter')await db.query('UPDATE hub_heads_v2 SET version=$2 WHERE id=$1',[e.hubId,cv]);
      else if(e.kind==='invite')await db.query("INSERT INTO hub_memberships_v2(id,hub_id,subject_id,version,charter_version,state,scopes,invite_id,expires_at) VALUES($1,$2,$3,1,$4,'invited',$5,$6,$7)",[e.membershipId,e.hubId,e.memberId,cv,JSON.stringify(e.scopes),e.id,e.expiresAt]);
      else if(['accept','decline','exit','remove'].includes(e.kind))await db.query('UPDATE hub_memberships_v2 SET version=$2,state=$3,decision_id=$4,scopes=COALESCE($5::jsonb,scopes) WHERE id=$1',
        [e.membershipId,objectVersion,{accept:'active',decline:'declined',exit:'exited',remove:'removed'}[e.kind],e.id,e.acceptedScopes?JSON.stringify(e.acceptedScopes):null]);
      else if(['suspend','resume'].includes(e.kind))await db.query('UPDATE hub_heads_v2 SET state=$2 WHERE id=$1',[e.hubId,e.kind==='suspend'?'suspended':'active']);
      else if(e.kind==='intake-open')await db.query("INSERT INTO hub_intake_v2(id,hub_id,subject_id,version,state,created_at,expires_at) VALUES($1,$2,$3,1,'open',$4,$5)",[e.threadId,e.hubId,actor.subjectId,this.now(),this.now()+7776000]);
      else await db.query('UPDATE hub_intake_v2 SET version=$2,state=$3 WHERE id=$1',[e.threadId,objectVersion,e.kind==='intake-close'?'closed':'open']);
      await this.audit(db,actor,row,a);return this.eventReceipt(row);
    });
  }
  eventReceipt(r){return{operationId:r.id,hubId:r.hub_id,kind:r.kind,version:r.object_version,objectId:r.object_id,
    charterVersion:r.charter_version,payloadHash:r.payload_hash,state:'recorded',...flags};}
  receipt(actor,input){const q=parsed(hubReceiptSchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    const r=await one(db,'SELECT * FROM hub_events_v2 WHERE id=$1 AND subject_id=$2',[q.operationId,actor.subjectId]);
    if(!r)return{operationId:q.operationId,state:'absent'};requireValue(r.payload_hash===q.payloadHash,'hub_receipt_conflict',409);return this.eventReceipt(r);});}
  intake(actor,input){const q=parsed(hubIntakeQuerySchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    const h=await this.head(db,q.hubId),rows=(await db.query(`SELECT * FROM hub_intake_v2 WHERE hub_id=$1 AND ($2::uuid IS NULL OR id=$2)
      AND ($3::uuid IS NULL OR id>$3) AND (subject_id=$4 OR $4=$5) ORDER BY id LIMIT $6`,[h.id,q.threadId??null,q.after??null,actor.subjectId,h.owner_id,q.limit+1])).rows,items=[];
    for(const t of rows.slice(0,q.limit)){const events=(await db.query('SELECT * FROM hub_events_v2 WHERE hub_id=$1 AND object_id=$2 ORDER BY object_version',[h.id,t.id])).rows,texts=[];
      for(const r of events){const readable=t.expires_at>this.now()&&await this.readable(db,actor,r),e=readable?event(r):null;
        texts.push({id:r.id,authorId:r.subject_id,kind:r.kind,version:r.object_version,contentAvailable:!!e,...(e?{title:e.title,text:e.text}:{}),receivedAt:Number(r.received_at)});}
      items.push({threadId:t.id,hubId:h.id,version:t.version,state:t.state,expiresAt:Number(t.expires_at),messages:texts});}
    return{items,nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,externalServiceResponseGuarantee:false};});}
  async purgeExpired(limit=100){const rows=(await this.access.db.query('SELECT id FROM hub_intake_v2 WHERE expires_at<=$1 ORDER BY id LIMIT $2',[this.now(),limit])).rows;
    for(const r of rows)await this.access.db.query("UPDATE hub_events_v2 SET payload_text='' WHERE object_id=$1 AND kind IN ('intake-open','intake-reply','intake-close')",[r.id]);
    return{processed:rows.length,scope:'expired-intake-content-only'};}
}
