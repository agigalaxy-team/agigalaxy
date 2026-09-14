import {configurationEventV2Schema,configurationReadV2Schema,configurationQueryV2Schema,configurationVersionsV2Schema,configurationReceiptV2Schema} from './shared/configuration-v2-schema.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import {transaction} from './database.mjs';
import {canReadProjection} from './domain/consent-policy.mjs';
import {recordObjectAudit} from './infrastructure/object-audit.mjs';
const rule=(ok,code,status=409)=>{if(!ok)throw new ServiceError(code,status);};
const parse=(schema,input)=>{const p=schema.safeParse(input);rule(p.success,'invalid_configuration_request',400);return p.data;};
const missing=e=>e instanceof ServiceError&&[403,404,409,422,503].includes(e.status);

// Selected, author-reported conditions only. This module never discovers a local
// environment, fetches external configuration or receives raw prompt/key files.
export class ConfigurationServiceV2{
 constructor(access,consents){this.access=access;this.consents=consents;}
 async submit(actor,input){
   let x;try{rule(typeof input?.payloadJson==='string'&&Buffer.byteLength(input.payloadJson)<=24000,'invalid_configuration_request',400);x=parse(configurationEventV2Schema,JSON.parse(input.payloadJson));}catch(e){if(e instanceof ServiceError)throw e;throw new ServiceError('invalid_configuration_request',400);}
   rule(x.actorId===actor.subjectId,'configuration_author_required',403);
   if(x.kind==='record')rule(Date.parse(x.observedAt)<=this.access.now()*1000,'configuration_future_observation',422);
   return this.access.runResourceWrite(actor,'history',{control:x.kind==='revoke'},async(db,authorization)=>{
     const intent=await this.consents.require(db,{id:input.consentId,subjectId:actor.subjectId,action:'configuration.publish',objectId:x.operationId,recipient:this.access.endpoint,payloadJson:input.payloadJson});
     rule(['Private','Public'].includes(intent.visibility),'configuration_visibility_required',403);
     if(x.kind==='record'&&x.expectedVersion===0)await db.query('INSERT INTO configuration_objects(id,subject_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[x.id,actor.subjectId]);
     const parent=(await db.query('SELECT * FROM configuration_objects WHERE id=$1 AND subject_id=$2 FOR UPDATE',[x.id,actor.subjectId])).rows[0];rule(parent,'configuration_unavailable',404);
     const prior=(await db.query('SELECT * FROM configuration_events WHERE operation_id=$1',[x.operationId])).rows[0],hash=digest(input.payloadJson);
     if(prior){rule(prior.configuration_id===x.id&&prior.subject_id===actor.subjectId&&prior.payload_hash===hash&&prior.consent_id===input.consentId,'configuration_operation_conflict');return {id:x.id,version:prior.version,operationId:x.operationId,acknowledged:true};}
     rule(parent.state==='active','configuration_revoked');rule(parent.version===x.expectedVersion,'configuration_version_conflict');
     rule(x.kind==='revoke'?parent.version>0:parent.version<1000,'configuration_version_limit',413);
     await db.query('INSERT INTO configuration_events(operation_id,configuration_id,subject_id,version,kind,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[x.operationId,x.id,actor.subjectId,parent.version+1,x.kind,input.consentId,input.payloadJson,hash]);
     await db.query('UPDATE configuration_objects SET version=$2,state=$3 WHERE id=$1',[x.id,parent.version+1,x.kind==='revoke'?'revoked':'active']);
     await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:x.operationId,action:'configuration.event',httpRequestId:actor.httpRequestId??null,...authorization});
     return {id:x.id,version:parent.version+1,operationId:x.operationId,acknowledged:true,actualInstallationVerified:false,sourceAuthority:'subject-reported-selected-conditions'};
   });
 }
 async eventWithin(db,actor,input){
   const p=parse(configurationReadV2Schema,input),parent=(await db.query('SELECT * FROM configuration_objects WHERE id=$1 FOR SHARE',[p.id])).rows[0];rule(parent,'configuration_unavailable',404);
   const version=p.version??parent.version,row=(await db.query('SELECT * FROM configuration_events WHERE configuration_id=$1 AND version=$2',[p.id,version])).rows[0];rule(row?.payload_text,'configuration_source_erased',404);
   rule(digest(row.payload_text)===row.payload_hash,'configuration_integrity_mismatch',500);
   const grant=await this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,action:'configuration.publish',objectId:row.operation_id,recipient:this.access.endpoint,payloadJson:row.payload_text});
   rule(canReadProjection(grant,{viewerId:actor?.subjectId,now:this.access.now(),hubEndpoint:this.access.endpoint}),'configuration_authorization_unavailable',403);
   return {parent,row,grant,payload:parse(configurationEventV2Schema,JSON.parse(row.payload_text))};
 }
 async readWithin(db,actor,input){
   const {parent,row,grant,payload}=await this.eventWithin(db,actor,input),revoked=parent.state==='revoked'||payload.kind==='revoke';
   return {id:parent.id,version:row.version,subjectId:row.subject_id,sourceStatus:revoked?'revoked':row.version===parent.version?'current':'historical-version',
     record:revoked?null:payload,contentAvailable:!revoked,actualInstallationVerified:false,unknownFieldsMeaning:'not-disclosed-or-not-known; no-equivalence-inferred',
     ...(actor?.subjectId===parent.subject_id?{management:{version:parent.version,state:parent.state},disclosure:{visibility:grant.visibility,viewers:grant.viewers}}:{})};
 }
 async conditionWithin(db,actor,ref){
   if(!ref)return {reference:null,sourceStatus:'not-recorded',record:null,conditionsKnown:false};
   try{const value=await this.readWithin(db,actor,{id:ref.id,version:ref.version});return {...value,reference:{id:ref.id,version:ref.version},conditionsKnown:!!value.record,meaning:'reported-conditions; not-authorization-to-republish'};}
   catch(e){if(!missing(e))throw e;return {reference:{id:ref.id,version:ref.version},sourceStatus:'unavailable',record:null,conditionsKnown:false,meaning:'conditions-unknown; existing-work-is-not-erased'};}
 }
 async requireReferenceWithin(db,actor,ref){const value=await this.readWithin(db,actor,{id:ref.id,version:ref.version});rule(value.record&&value.contentAvailable,'configuration_content_unavailable',403);return value;}
 async managedWithin(db,actor,p){
   try{return await this.readWithin(db,actor,p);}catch(e){
     if(!missing(e)||!actor?.subjectId)throw e;
     const parent=(await db.query('SELECT id,version,state FROM configuration_objects WHERE id=$1 AND subject_id=$2',[p.id,actor.subjectId])).rows[0];
     if(!parent)throw e;
     return {id:parent.id,version:p.version??parent.version,subjectId:actor.subjectId,sourceStatus:'source-unavailable',contentAvailable:false,record:null,
       management:{version:parent.version,state:parent.state},actualInstallationVerified:false};
   }
 }
 get(actor,input){const p=parse(configurationReadV2Schema,input);return actor?this.access.runAuthorized(actor,'history',db=>this.managedWithin(db,actor,p)):transaction(this.access.db,db=>this.readWithin(db,null,p));}
 async query(actor,input={}){const p=parse(configurationQueryV2Schema,input);const read=async db=>{
   const rows=(await db.query('SELECT id FROM configuration_objects WHERE ($1::text IS NULL OR subject_id=$1) ORDER BY id',[p.subjectId??null])).rows,items=[];
   for(const row of rows)try{const v=await this.managedWithin(db,actor,{id:row.id});if(v.record||v.management)items.push(v);}catch(e){if(!missing(e))throw e;}
   const rest=items.filter(v=>!p.after||v.id>p.after),page=rest.slice(0,p.limit);return {items:page,nextAfter:rest.length>p.limit?page.at(-1).id:null,coverage:'currently-authorized-configurations'};};
   return actor?this.access.runAuthorized(actor,'history',read):transaction(this.access.db,read);}
 async versions(actor,input){const p=parse(configurationVersionsV2Schema,input);const read=async db=>{
   const rows=(await db.query('SELECT version FROM configuration_events WHERE configuration_id=$1 AND version>$2 ORDER BY version',[p.id,p.afterVersion])).rows,items=[];
   for(const row of rows)try{items.push(await this.readWithin(db,actor,{id:p.id,version:row.version}));}catch(e){if(!missing(e))throw e;}
   const page=items.slice(0,p.limit);return {id:p.id,items:page,nextAfterVersion:items.length>p.limit?page.at(-1).version:null};};
   return actor?this.access.runAuthorized(actor,'history',read):transaction(this.access.db,read);}
 async receipt(actor,input){const p=parse(configurationReceiptV2Schema,input);return this.access.runAuthorized(actor,'history',async db=>{
   const row=(await db.query('SELECT configuration_id,version,payload_hash,consent_id FROM configuration_events WHERE operation_id=$1 AND subject_id=$2',[p.operationId,actor.subjectId])).rows[0];
   return {operationId:p.operationId,state:!row?'absent':row.payload_hash===p.payloadHash?'acknowledged':'conflict',currentReadPermissionConfirmed:false,...(row?.payload_hash===p.payloadHash?{id:row.configuration_id,version:row.version,consentId:row.consent_id}:{})};});}
}
