import {decodeJwt} from 'jose';
import {hubReceiptSchema} from './shared/hubs-v2-schema.mjs';
import {peeringListSchema,peeringPreviewSchema,peeringSourcesSchema,peeringConnectionsSchema} from './shared/hub-peering-v2-schema.mjs';
import {peeringEventSchema,peeringReadSchema,peeringQuerySchema,peerExchangeRequestSchema,peeringSourceSchema} from './shared/hub-peering-v2-schema.mjs';
import {verifyEnvelope} from './signed-envelope.mjs';
import {validatePublicUrl} from './public-fetch.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import {transaction} from './database.mjs';
const one=async(db,q,a)=>(await db.query(q,a)).rows[0];
const need=(ok,code='peering_unavailable',status=404)=>{if(!ok)throw new ServiceError(code,status);};
const parse=(schema,input)=>{const p=schema.safeParse(input);need(p.success,'invalid_peering_request',400);return p.data;};
const payload=row=>row?.payload_text?JSON.parse(row.payload_text):null;
const unavailable=e=>e instanceof ServiceError&&[403,404,409,410,422].includes(e.status);
const flags={route:'direct',intermediaries:[],officialProtocolFee:0,rawContextIncluded:false,capabilityVerified:false,independentSourcesAdded:0,
  autonomousDomainVerified:false,responseBodyPersisted:false};
// Each endpoint signs only its own scoped authentication/observation. The
// original Proof remains signed by its original issuer, never imported as a
// locally verified Case or capability. No process is impersonated as author.
export class HubPeeringServiceV2{
  constructor(hubs,{ciV2,sharing,sign,send}){Object.assign(this,{hubs,ciV2,sharing,sign,send});this.access=hubs.access;this.now=hubs.now;this.endpoint=hubs.endpoint;}
  async eventGrant(db,row){return this.hubs.grant(db,row);}
  async agreementWithin(db,id,hubId){const row=await one(db,'SELECT * FROM hub_peering_agreements_v2 WHERE id=$1 AND hub_id=$2 FOR SHARE',[id,hubId]);
    need(row?.state==='local-approved'&&row.expires_at>this.now());const e=await one(db,'SELECT * FROM hub_peering_events_v2 WHERE id=$1',[row.event_id]);
    const g=await this.eventGrant(db,e),p=payload(e),agreement=p.agreement;
    need(digest(JSON.stringify(agreement))===row.agreement_hash,'peering_integrity_mismatch',500);
    const local=agreement.parties.find(p=>p.endpoint===this.endpoint),remote=agreement.parties.find(p=>p.endpoint!==this.endpoint);
    need(local?.hubId===hubId&&local.operatorId===row.subject_id&&remote,'peering_party_mismatch',409);
    const head=await this.hubs.head(db,hubId);need(head.owner_id===row.subject_id&&head.state==='active');
    // Read current operator-authorized Charter without granting its contents to
    // the requesting foreign actor; only status gates the scope here.
    const charter=await one(db,"SELECT * FROM hub_events_v2 WHERE hub_id=$1 AND kind='charter' AND charter_version=$2",[hubId,head.version]);
    await this.eventGrant(db,charter);const c=payload(charter),b=await this.hubs.builders.load(db,hubId),current=b.declaration;
    need(current?.id===c.declarationId&&current.payload_hash===c.declarationHash,'peering_charter_changed',409);
    const declarationGrant=await this.hubs.builders.grant(db,current);need(!declarationGrant.currentVisibility?.deletionPending);
    const maintenance=this.hubs.builders.maintenance(b.rows);need(!maintenance.delisted&&!maintenance.securityIssue);
    return{row,event:e,grant:g,agreement,local,remote,head};
  }
  async sourceWithin(db,actor,source,{authorId,forGrant:_forGrant=false}={}){
    parse(peeringSourceSchema,source);
    if(source.kind==='ci-proof-v2'){
      const row=await one(db,'SELECT * FROM ci_proofs_v2 WHERE id=$1',[source.id]);
      need(row?.subject_id===authorId&&row.payload_hash===source.payloadHash&&row.payload_text,'peering_source_unavailable');
      const view=await this.ciV2.proofWithin(db,actor,source.id);need(view.data.issuer===this.endpoint,'peering_foreign_issuer_not_delegated',403);
      // Proof publication and new bounded peer grant must both allow this
      // request actor; a private Proof is not widened by a network membership.
      return{sourceKey:view.provenance.sourceKey,sourceObject:{kind:source.kind,id:source.id,payloadHash:source.payloadHash},
        issuer:view.data.issuer,subjectId:view.data.subject,authority:view.provenance.authority,signed:view.signed,
        observedAt:view.data.observedAt,expiresAt:view.data.expiresAt,synthetic:view.data.synthetic,capabilityVerified:false};
    }
    const row=await this.sharing.sourceWithin(db,source.source);need(row.subject_id===authorId,'peering_source_author_required',403);
    await this.sharing.sourceGrantWithin(db,source.source.kind,row);
    // This new grant explicitly licenses these nonnarrative authored fields to
    // the listed remote readers. Honor-only publication is never reused here.
    const projection=this.sharing.project(row,source.fields);
    const authored=JSON.parse(row.payload_text),fact=authored.event??authored;
    const parent=source.source.kind==='case-event'
      ?await one(db,"SELECT payload_text FROM case_events WHERE case_id=$1 AND kind='case-created' ORDER BY created_at,id LIMIT 1",[row.case_id])
      :await one(db,'SELECT snapshot FROM task_requests WHERE id=$1',[row.task_id]);
    const root=source.source.kind==='case-event'?payload(parent):parent?.snapshot;
    const synthetic=fact.synthetic===true?true:root?!!(root.synthetic||root.request?.synthetic):null;
    return{sourceKey:digest(JSON.stringify([this.endpoint,source.source.kind,source.source.id,source.source.payloadHash])),
      sourceObject:source.source,issuer:this.endpoint,subjectId:row.subject_id,authority:'author-selected-contribution-summary',projection,
      observedAt:Number(row.received_at??this.now()),capabilityVerified:false,independentExecutionVerified:false,
      synthetic,originalTextAccessGranted:false};
  }
  async append(db,actor,e,consentId,payloadJson,a){const r={id:e.id,hub_id:e.hubId,subject_id:actor.subjectId,kind:e.kind,
    object_id:e.agreement?.id??e.agreementId??e.grantId,consent_id:consentId,payload_text:payloadJson,payload_hash:digest(payloadJson),received_at:this.now()};
    await db.query('INSERT INTO hub_peering_events_v2(id,hub_id,subject_id,kind,object_id,consent_id,payload_text,payload_hash,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [r.id,r.hub_id,r.subject_id,r.kind,r.object_id,consentId,payloadJson,r.payload_hash,r.received_at]);
    await this.hubs.audit(db,actor,r,a);return r;
  }
  async change(db,row,state){if(row.last_state===state)return;
    await db.query('UPDATE hub_peering_grants_v2 SET last_state=$2 WHERE id=$1',[row.id,state]);
    await db.query('INSERT INTO hub_peering_changes_v2(grant_id,agreement_id,subject_id,state,observed_at) VALUES($1,$2,$3,$4,$5)',[row.id,row.agreement_id,row.subject_id,state,this.now()]);}
  async publicationMembershipWithin(db,subjectId,ag){
    if(ag.head.owner_id===subjectId)return;
    // Inspect the publisher's relationship as a scope condition, not by
    // impersonating them to read a source for the remote requesting user.
    const m=await one(db,"SELECT * FROM hub_memberships_v2 WHERE hub_id=$1 AND subject_id=$2 AND state='active' FOR SHARE",[ag.head.id,subjectId]);
    need(m&&m.charter_version===ag.head.version&&m.expires_at>this.now()&&m.scopes.includes('approved-proof-query'),'peering_source_membership_inactive',403);
    for(const id of[m.invite_id,m.decision_id])await this.eventGrant(db,await one(db,'SELECT * FROM hub_events_v2 WHERE id=$1',[id]));
  }
  async submit(actor,{consentId,payloadJson}){let e;try{need(typeof payloadJson==='string'&&Buffer.byteLength(payloadJson)<=48000);e=peeringEventSchema.parse(JSON.parse(payloadJson));}catch{throw new ServiceError('invalid_peering_event',400);}
    return this.access.runResourceWrite(actor,'builders',{control:['peer-exit','source-revoke'].includes(e.kind)},async(db,a)=>{
      const grant=await this.eventGrant(db,{id:e.id,subject_id:actor.subjectId,consent_id:consentId,payload_text:payloadJson});
      need(grant.visibility==='Private'&&!grant.viewers.length,'peering_control_intent_private',403);
      const prior=await one(db,'SELECT * FROM hub_peering_events_v2 WHERE id=$1',[e.id]);
      if(prior){need(prior.subject_id===actor.subjectId&&prior.consent_id===consentId&&prior.payload_hash===digest(payloadJson),'peering_event_conflict',409);return this.receiptOf(prior);}
      const head=await this.hubs.head(db,e.hubId,'UPDATE');
      if(e.kind==='peer-approve'){
        need(head.owner_id===actor.subjectId,'hub_operator_required',403);await this.hubs.currentWithin(db,actor,e.hubId);
        const declaration=await this.hubs.builders.current(db,actor,await this.hubs.builders.load(db,e.hubId));
        need(declaration.payload.endpoint===this.endpoint,'peering_local_endpoint_mismatch',409);
        const ag=e.agreement,local=ag.parties.find(p=>p.endpoint===this.endpoint),remote=ag.parties.find(p=>p.endpoint!==this.endpoint);
        need(local?.hubId===e.hubId&&local.operatorId===actor.subjectId&&remote,'peering_party_mismatch',409);
        for(const party of ag.parties){validatePublicUrl(party.endpoint);need(new Set(party.keys.map(k=>k.kid)).size===party.keys.length,'peering_duplicate_key',400);
          for(const pin of party.keys)need(pin.notBefore<=this.now()&&pin.notAfter>=ag.expiresAt,'peering_pin_time_mismatch',400);}
        // User approval pins the peer key; own pins must actually be configured
        // for this signing service. A supplied public key cannot self-certify.
        for(const pin of local.keys){const current=this.access.trustedKeys.get(pin.kid);need(current&&!current.revoked&&current.publicKeyPem===pin.publicKeyPem
          &&current.notBefore<=pin.notBefore&&current.notAfter>=pin.notAfter,'peering_local_key_mismatch',409);}
        need(ag.expiresAt>this.now()&&ag.expiresAt<=grant.expiresAt&&ag.version===e.expectedVersion+1,'peering_expiry_or_version',400);
        const previous=await one(db,'SELECT * FROM hub_peering_agreements_v2 WHERE id=$1 FOR UPDATE',[ag.id]);
        need(previous?previous.hub_id===e.hubId&&previous.subject_id===actor.subjectId&&previous.version===e.expectedVersion:e.expectedVersion===0,'peering_version_conflict',409);
        const r=await this.append(db,actor,e,consentId,payloadJson,a);
        await db.query(`INSERT INTO hub_peering_agreements_v2(id,hub_id,subject_id,version,agreement_hash,state,event_id,expires_at) VALUES($1,$2,$3,$4,$5,'local-approved',$6,$7)
          ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,agreement_hash=EXCLUDED.agreement_hash,state='local-approved',event_id=EXCLUDED.event_id,expires_at=EXCLUDED.expires_at`,
          [ag.id,e.hubId,actor.subjectId,ag.version,digest(JSON.stringify(ag)),e.id,ag.expiresAt]);return this.receiptOf(r);
      }
      if(e.kind==='peer-exit'){
        const prior=await one(db,'SELECT * FROM hub_peering_agreements_v2 WHERE id=$1 AND hub_id=$2 FOR UPDATE',[e.agreementId,e.hubId]);
        need(prior?.subject_id===actor.subjectId&&prior.version===e.expectedVersion,'peering_operator_or_version',409);
        const r=await this.append(db,actor,e,consentId,payloadJson,a);await db.query("UPDATE hub_peering_agreements_v2 SET state='exited' WHERE id=$1",[e.agreementId]);return this.receiptOf(r);
      }
      if(e.kind==='source-revoke'){
        const source=await one(db,'SELECT * FROM hub_peering_grants_v2 WHERE id=$1 AND hub_id=$2 AND subject_id=$3 FOR UPDATE',[e.grantId,e.hubId,actor.subjectId]);need(source);
        const r=await this.append(db,actor,e,consentId,payloadJson,a);await db.query('UPDATE hub_peering_grants_v2 SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1',[source.id,this.now()]);await this.change(db,source,'unavailable');return this.receiptOf(r);
      }
      await this.hubs.requireMemberWithin(db,actor,e.hubId,'approved-proof-query');const ag=await this.agreementWithin(db,e.agreementId,e.hubId);
      need(e.agreementVersion===ag.row.version&&ag.agreement.sourceKinds.includes(e.source.kind)&&e.expiresAt>this.now()&&e.expiresAt<=Math.min(grant.expiresAt,ag.row.expires_at),'peering_grant_scope_mismatch',409);
      await this.sourceWithin(db,actor,e.source,{authorId:actor.subjectId,forGrant:true});
      const r=await this.append(db,actor,e,consentId,payloadJson,a);await db.query('INSERT INTO hub_peering_grants_v2(id,hub_id,subject_id,agreement_id,agreement_version,requester_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [e.id,e.hubId,actor.subjectId,e.agreementId,e.agreementVersion,JSON.stringify(e.requesterIds),e.expiresAt]);
      await this.change(db,{id:e.id,agreement_id:e.agreementId,subject_id:actor.subjectId,last_state:'uninspected'},'permitted');return this.receiptOf(r);
    });
  }
  receiptOf(row){return{operationId:row.id,hubId:row.hub_id,objectId:row.object_id,kind:row.kind,payloadHash:row.payload_hash,state:'recorded',...flags};}
  party(actor,input){const q=parse(peeringConnectionsSchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    const h=await this.hubs.currentWithin(db,actor,q.hubId);need(h.head.owner_id===actor.subjectId,'hub_operator_required',403);
    const keys=[...this.access.trustedKeys].filter(([,k])=>!k.revoked&&k.notBefore<=this.now()&&k.notAfter>this.now())
      .sort((a,b)=>b[1].notBefore-a[1].notBefore).slice(0,3).map(([kid,k])=>({kid,publicKeyPem:k.publicKeyPem,notBefore:k.notBefore,notAfter:k.notAfter}));
    return{party:{endpoint:this.endpoint,hubId:q.hubId,operatorId:actor.subjectId,keys},authority:'currently-configured-service-pins; remote operator must explicitly choose them',...flags};});}
  connections(actor,input){const q=parse(peeringConnectionsSchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    await this.hubs.requireMemberWithin(db,actor,q.hubId,'approved-proof-query');const rows=(await db.query('SELECT id FROM hub_peering_agreements_v2 WHERE hub_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[q.hubId,q.after??null,q.limit+1])).rows,items=[];
    for(const r of rows.slice(0,q.limit))try{const a=await this.agreementWithin(db,r.id,q.hubId);items.push({agreementId:a.row.id,version:a.row.version,agreementHash:a.row.agreement_hash,peer:a.remote.endpoint,sourceKinds:a.agreement.sourceKinds,expiresAt:Number(a.row.expires_at),remoteApproval:'requires-current-query'});}catch(e){if(!unavailable(e))throw e;}
    return{items,nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,...flags};});}
  sources(actor,input){const q=parse(peeringSourcesSchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    await this.hubs.requireMemberWithin(db,actor,q.hubId,'approved-proof-query');const table=q.kind==='ci-proof-v2'?'ci_proofs_v2':q.kind==='case-event'?'case_events':'task_events';
    const filter=q.kind==='ci-proof-v2'?'TRUE':q.kind==='case-event'?'case_id=$4':'task_id=$4';
    const args=[actor.subjectId,q.after??null,q.limit+1,...(q.kind==='ci-proof-v2'?[]:[q.parentId])];
    const rows=(await db.query(`SELECT * FROM ${table} WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ${filter} ORDER BY id LIMIT $3`,args)).rows,items=[];
    for(const row of rows.slice(0,q.limit))try{const source=q.kind==='ci-proof-v2'?{kind:q.kind,id:row.id,payloadHash:row.payload_hash}
      :{kind:'contribution-summary',source:{kind:q.kind,id:row.id,eventVersion:1,payloadHash:row.payload_hash},fields:['eventType','actorId']};
      const preview=await this.sourceWithin(db,actor,source,{authorId:actor.subjectId,forGrant:true});items.push({source,eventType:preview.projection?.eventType??'ci-observation-proof',synthetic:preview.synthetic});
    }catch(e){if(!unavailable(e))throw e;}return{items,nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,sourceTextIncluded:false,...flags};});}
  receipt(actor,input){const q=parse(hubReceiptSchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    const r=await one(db,'SELECT * FROM hub_peering_events_v2 WHERE id=$1 AND subject_id=$2',[q.operationId,actor.subjectId]);
    if(!r)return{operationId:q.operationId,state:'absent'};need(r.payload_hash===q.payloadHash,'peering_receipt_conflict',409);return this.receiptOf(r);});}
  list(actor,input){const q=parse(peeringListSchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    const table=q.kind==='agreements'?'hub_peering_agreements_v2':'hub_peering_grants_v2';
    const rows=(await db.query(`SELECT * FROM ${table} WHERE hub_id=$1 AND subject_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,[q.hubId,actor.subjectId,q.after??null,q.limit+1])).rows;
    const items=[];for(const row of rows.slice(0,q.limit)){
      const e=await one(db,'SELECT * FROM hub_peering_events_v2 WHERE id=$1',[q.kind==='agreements'?row.event_id:row.id]);
      let record=null;try{await this.eventGrant(db,e);record=payload(e);}catch(x){if(!unavailable(x))throw x;}
      items.push({id:row.id,version:row.version??row.agreement_version,state:row.state??(row.revoked_at?'revoked':'granted'),expiresAt:Number(row.expires_at),record,
        recordHash:e?.payload_hash??null,currentSourceStatus:'requires-current-query',availableActions:q.kind==='agreements'?(row.state!=='exited'?['peer-exit']:[]):(!row.revoked_at?['source-revoke']:[])});
    }return{items,nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,...flags};});}
  preview(actor,input){const q=parse(peeringPreviewSchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    await this.hubs.requireMemberWithin(db,actor,q.hubId,'approved-proof-query');
    const ag=await this.agreementWithin(db,q.agreementId,q.hubId);
    need(ag.agreement.sourceKinds.includes(q.source.kind),'peering_kind_not_agreed',409);
    const projection=await this.sourceWithin(db,actor,q.source,{authorId:actor.subjectId,forGrant:true});
    return{source:q.source,projection,agreementVersion:ag.row.version,peer:ag.remote.endpoint,maxExpiresAt:Number(ag.row.expires_at),published:false,...flags};});}
  read(actor,input){const q=parse(peeringReadSchema,input);return this.access.runAuthorized(actor,'builders',async db=>{
    const h=await this.hubs.head(db,q.hubId);need(actor.subjectId===h.owner_id,'hub_operator_required',403);
    const a=await one(db,'SELECT * FROM hub_peering_agreements_v2 WHERE id=$1 AND hub_id=$2',[q.agreementId,q.hubId]);need(a);
    const e=await one(db,'SELECT * FROM hub_peering_events_v2 WHERE id=$1',[a.event_id]);let record=null;
    try{await this.eventGrant(db,e);record=payload(e)?.agreement;}catch(x){if(!unavailable(x))throw x;}
    return{agreementId:a.id,hubId:a.hub_id,version:a.version,agreementHash:a.agreement_hash,state:a.state,agreement:record,
      remoteApproval:'not-established-by-local-record',...flags};});}
  async saveReceipt(db,q,side,hash){
    // Lock absent operations as well as existing ones, then the shared quota.
    // These separate transaction locks never upgrade agreementWithin's SHARE
    // row lock. The same order applies to every incoming/outgoing caller.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[`galaxy-peering-query/${side}`,q.queryId]);
    const prior=await one(db,'SELECT * FROM hub_peering_receipts_v2 WHERE query_id=$1 AND side=$2 FOR UPDATE',[q.queryId,side]);
    if(prior){need(prior.request_hash===hash&&prior.subject_id===q.requesterId&&prior.agreement_id===q.agreementId,'peering_query_conflict',409);return;}
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[`galaxy-peering-quota/${side}`,q.agreementId]);
    const row=await one(db,'SELECT count(*)::int AS n FROM hub_peering_receipts_v2 WHERE agreement_id=$1 AND side=$2 AND created_at>$3',[q.agreementId,side,this.now()-60]);
    const ag=await one(db,'SELECT event_id FROM hub_peering_agreements_v2 WHERE id=$1',[q.agreementId]),e=await one(db,'SELECT payload_text FROM hub_peering_events_v2 WHERE id=$1',[ag.event_id]);
    need(row.n<payload(e).agreement.ratePerMinute,'peering_rate_limited',429);
    await db.query("INSERT INTO hub_peering_receipts_v2(query_id,side,agreement_id,subject_id,request_hash,state,created_at,checked_at) VALUES($1,$2,$3,$4,$5,'pending',$6,$6)",[q.queryId,side,q.agreementId,q.requesterId,hash,this.now()]);}
  async grantProjection(db,row,requesterId,ag){const e=await one(db,'SELECT * FROM hub_peering_events_v2 WHERE id=$1',[row.id]),p=payload(e);
    try{need(!row.revoked_at&&row.expires_at>this.now()&&row.agreement_version===ag.row.version&&row.requester_ids.includes(requesterId));await this.eventGrant(db,e);
      await this.publicationMembershipWithin(db,row.subject_id,ag);
      need(p&&ag.agreement.sourceKinds.includes(p.source.kind));
      const view=await this.sourceWithin(db,{subjectId:requesterId,authenticationSource:'explicitly-pinned-peer-scope'},p.source,{authorId:row.subject_id});
      // Preserve the original proof bytes while applying the separate, shorter
      // source permission to this projection. Its expiry is not proof validity.
      await this.change(db,row,'permitted');return{...view,grantId:row.id,state:'current',expiresAt:Math.min(Number(row.expires_at),view.expiresAt??Number(row.expires_at))};
    }catch(error){if(!unavailable(error))throw error;await this.change(db,row,'unavailable');return{grantId:row.id,state:'unavailable'};}}
  async exchange(input){need(input&&Object.keys(input).join(',')==='signed'&&typeof input.signed==='string'&&Buffer.byteLength(input.signed)<=65536,'invalid_peering_envelope',400);
    let q;try{q=parse(peerExchangeRequestSchema,decodeJwt(input.signed).data);}catch{throw new ServiceError('peering_unavailable',404);}
    return transaction(this.access.db,async db=>{
      const ag=await this.agreementWithin(db,q.agreementId,q.toHubId),pins=new Map(ag.remote.keys.map(k=>[k.kid,{...k,revoked:false}]));
      let verified;try{verified=await verifyEnvelope(input.signed,{type:'hub-peering',issuer:ag.remote.endpoint,audience:ag.remote.endpoint,trustedKeys:pins,now:this.now(),maxAge:ag.agreement.responseMaxAgeSeconds});}
      catch{throw new ServiceError('peering_unavailable',404);}
      need(verified.id===q.queryId&&q.origin===ag.remote.endpoint&&q.destination===this.endpoint&&q.fromHubId===ag.remote.hubId&&q.agreementHash===ag.row.agreement_hash,'peering_scope_changed',409);
      await this.saveReceipt(db,q,'incoming',digest(JSON.stringify(q)));
      const changes=(await db.query(`SELECT max(c.sequence)::bigint AS sequence,g.* FROM hub_peering_changes_v2 c JOIN hub_peering_grants_v2 g ON g.id=c.grant_id
        WHERE c.agreement_id=$1 AND g.requester_ids @> $2::jsonb GROUP BY g.id HAVING max(c.sequence)>$3 ORDER BY max(c.sequence) LIMIT $4`,
        [q.agreementId,JSON.stringify([q.requesterId]),q.after,ag.agreement.pageSize+1])).rows;
      // The signed outer envelope adds base64 overhead. Page size is a maximum,
      // never permission to exceed the transport body bound.
      const selected=[],items=[],deferredRecheck=[];let bytes=0;
      const append=item=>{const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>38000)return false;items.push(item);bytes+=size;return true;};
      for(const row of changes.slice(0,ag.agreement.pageSize)){
        if(!append(await this.grantProjection(db,row,q.requesterId,ag)))break;selected.push(row);}
      for(const id of q.recheck)if(!selected.some(row=>row.id===id)){
        const r=await one(db,'SELECT * FROM hub_peering_grants_v2 WHERE id=$1 AND agreement_id=$2 AND requester_ids @> $3::jsonb',[id,q.agreementId,JSON.stringify([q.requesterId])]);
        if(!append(r?await this.grantProjection(db,r,q.requesterId,ag):{grantId:id,state:'unavailable'}))deferredRecheck.push(id);}
      const checkedAt=this.now(),expiresAt=Math.min(checkedAt+ag.agreement.responseMaxAgeSeconds,Number(ag.row.expires_at),
        ...items.filter(item=>item.state==='current').map(item=>item.expiresAt));
      need(expiresAt>checkedAt,'peering_response_expired',409);
      const data={profile:'galaxy-direct-proof/1',kind:'response',queryId:q.queryId,requestHash:digest(JSON.stringify(q)),agreementId:q.agreementId,agreementHash:q.agreementHash,
        origin:this.endpoint,destination:q.origin,fromHubId:q.toHubId,toHubId:q.fromHubId,requesterId:q.requesterId,purpose:q.purpose,items,
        nextCursor:selected.length?Number(selected.at(-1).sequence):q.after,hasMore:changes.length>selected.length,deferredRecheck,checkedAt,
        expiresAt,coverage:'explicit-source-grants-for-exact-peer-and-reader',...flags};
      need(this.sign,'peering_signer_unavailable',503);const signed=await this.sign('hub-peering',data,q.queryId,data.expiresAt-this.now());
      await db.query("UPDATE hub_peering_receipts_v2 SET state='delivered',response_hash=$3,checked_at=$4 WHERE query_id=$1 AND side=$2",[q.queryId,'incoming',digest(signed),this.now()]);return{signed};
    });
  }
  async query(actor,input){const p=parse(peeringQuerySchema,input),snapshot=await this.access.runAuthorized(actor,'builders',async db=>{
    await this.hubs.requireMemberWithin(db,actor,p.hubId,'approved-proof-query');const ag=await this.agreementWithin(db,p.agreementId,p.hubId);
    const q={profile:'galaxy-direct-proof/1',kind:'query',queryId:p.queryId,agreementId:p.agreementId,agreementHash:ag.row.agreement_hash,
      fromHubId:p.hubId,toHubId:ag.remote.hubId,requesterId:actor.subjectId,origin:this.endpoint,destination:ag.remote.endpoint,purpose:'help-discovery',after:p.after,recheck:p.recheck};
    await this.saveReceipt(db,q,'outgoing',digest(JSON.stringify(q)));return{ag,q};});
    need(this.sign&&this.send,'peering_transport_unavailable',503);const {q,ag}=snapshot;
    try{const signed=await this.sign('hub-peering',q,q.queryId,Math.min(ag.agreement.responseMaxAgeSeconds,Number(ag.row.expires_at)-this.now()));
      const response=await this.send(ag.remote.endpoint+'/v2/hubs/peering/exchange',{bodyJson:JSON.stringify({signed}),timeoutMs:5000,maxBytes:65536});
      const checked=await verifyEnvelope(response?.signed,{type:'hub-peering',issuer:ag.remote.endpoint,audience:ag.remote.endpoint,
        trustedKeys:new Map(ag.remote.keys.map(k=>[k.kid,{...k,revoked:false}])),now:this.now(),maxAge:ag.agreement.responseMaxAgeSeconds}),v=checked.data;
      need(v.profile==='galaxy-direct-proof/1'&&v.kind==='response'&&checked.id===q.queryId&&v.queryId===q.queryId&&v.requestHash===digest(JSON.stringify(q))
        &&v.agreementId===q.agreementId&&v.agreementHash===q.agreementHash&&v.origin===q.destination&&v.destination===q.origin&&v.fromHubId===q.toHubId&&v.toHubId===q.fromHubId
        &&v.requesterId===actor.subjectId&&v.purpose===q.purpose&&v.expiresAt>this.now()&&v.rawContextIncluded===false&&v.route==='direct'&&v.intermediaries?.length===0,'peering_response_mismatch',409);
      // Parse a finite allowlist before returning or storing anything. Foreign
      // excess properties, including private text in an unavailable item, fail.
      const validated=await this.validateResponse(v,ag),clean={...validated,expiresAt:Math.min(validated.expiresAt,checked.expiresAt)};
      return await this.access.runAuthorized(actor,'builders',async db=>{await this.hubs.requireMemberWithin(db,actor,p.hubId,'approved-proof-query');
        const current=await this.agreementWithin(db,p.agreementId,p.hubId);need(current.row.agreement_hash===q.agreementHash,'peering_scope_changed',409);
        need(clean.expiresAt>this.now(),'peering_response_expired',409);
        await db.query("UPDATE hub_peering_receipts_v2 SET state='delivered',response_hash=$3,checked_at=$4 WHERE query_id=$1 AND side=$2",[q.queryId,'outgoing',digest(response.signed),this.now()]);
        return{...clean,remoteApproval:'verified-for-this-current-query',peerAuthentication:'selected-peer-operator-attestation-within-explicit-read-scope',...flags};});
    }catch(e){await this.access.db.query("UPDATE hub_peering_receipts_v2 SET state='unknown',response_hash=NULL,checked_at=$3 WHERE query_id=$1 AND side=$2",[q.queryId,'outgoing',this.now()]);
      if(e instanceof ServiceError&&[401,403,409].includes(e.status))throw e;
      return{queryId:q.queryId,state:'unknown',currentSourceStatus:'unknown',items:[],retryAfterReconciliation:true,...flags};}
  }
  async validateResponse(value,ag){
    // The full strict schema and per-source original signature verification are
    // deliberately supplied in one shared validator, also consumed by tests.
    return validatePeerResponse(value,{agreement:ag.agreement,peer:ag.remote,now:this.now()});
  }
}

import {validatePeerResponse} from './verification/hub-peering-v2.mjs';
