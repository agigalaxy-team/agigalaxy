import {isDeepStrictEqual} from 'node:util';
import {transaction} from "../../infrastructure/database.mjs";
import {contentSnapshotSchema} from "../../publishing/content-publications.mjs";
import {ServiceError} from '../../shared/service-error.mjs';
import {systemGeneralPublishSchema,parseSystemGeneral} from './general-schema.mjs';
import {systemSettingsUuidSchema,parseSystemSettings} from './schema.mjs';

const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const iso=value=>new Date(value).toISOString();
export class SystemGeneralPublications{
 constructor({businessAdmin,contentPublications,websiteOrigin,fetchImpl=fetch,now=businessAdmin.now}){
  const url=new URL(websiteOrigin);if(url.protocol!=='https:'||url.origin!==websiteOrigin||url.username||url.password)throw Error('Explicit public website origin required');
  Object.assign(this,{businessAdmin,contentPublications,websiteOrigin,fetchImpl,now,db:businessAdmin.db,endpoint:businessAdmin.endpoint});
 }
 envelope(){return{checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true};}
 require(operator,action,db=this.db){if(operator?.kind!=='business-operator')fail('system_settings_permission_denied',403);return this.businessAdmin.authorizeAction(this.businessAdmin.require(operator),action,{db});}
 async fresh(operator,authorize,db=this.db){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);const actor=await authorize();
  if(actor?.operatorId!==operator.operatorId||actor.endpoint!==this.endpoint)fail('business_admin_denied',403);return this.require(actor,'system.settings.apply',db);
 }
 async marker(){
  try{
   const response=await this.fetchImpl(this.websiteOrigin+'/cms-publication.json',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
   if(!response.ok)fail('system_settings_source_changed',503);const raw=await response.text();if(Buffer.byteLength(raw)>4096)throw Error();
   const value=JSON.parse(raw);if(value?.version!==1||!systemSettingsUuidSchema.safeParse(value.publicationId).success)throw Error();
   return value.publicationId.toLowerCase();
  }catch{fail('system_settings_source_changed',503);}
 }
 async source(operator){
  await this.require(operator,'system.settings.read');let id=null,state='unavailable';
  try{id=await this.marker();const row=(await this.db.query('SELECT id FROM site_publications_v1 WHERE id=$1 AND endpoint=$2',[id,this.endpoint])).rows[0];
   if(row)state='available';else id=null;
  }catch{/* A missing current source never becomes an empty content snapshot. */}
  await this.require(operator,'system.settings.read');return{publication:{id,state},...this.envelope()};
 }
 async publishedGeneral(operator){
  await this.require(operator,'system.settings.read');let result={publication:{id:null,state:'unavailable'},configuration:null};
  try{
   const id=await this.marker(),row=(await this.db.query('SELECT snapshot FROM site_publications_v1 WHERE id=$1 AND endpoint=$2',[id,this.endpoint])).rows[0];
   if(row){const configuration=contentSnapshotSchema.shape.settings.parse(row.snapshot?.settings);
    if(await this.marker()===id)result={publication:{id,state:'available'},configuration};}
  }catch{/* A missing, changed or invalid current publication is never a saved draft. */}
  await this.require(operator,'system.settings.read');return{...result,basis:'current-public-website-publication',savedDraft:{state:'not-read',configuration:null},...this.envelope()};
 }
 async publish(operator,input,{authorize}={}){
  const data=parseSystemGeneral(systemGeneralPublishSchema,input);await this.fresh(operator,authorize);
  const prior=(await this.db.query('SELECT * FROM operations_system_general_publications_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,data.operationId])).rows[0];
  if(prior){this.same(prior,operator,data);return this.operation(operator,data.operationId);}
  const currentPublicationId=await this.marker();
  return transaction(this.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912465))',[this.endpoint]);
   const actor=await this.fresh(operator,authorize,db),old=(await db.query('SELECT * FROM operations_system_general_publications_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,data.operationId])).rows[0];
   if(old){this.same(old,actor,data);return this.result(db,old);}
   const base=(await db.query('SELECT snapshot FROM site_publications_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,data.expectedPublicationId])).rows[0];
   if(currentPublicationId!==data.expectedPublicationId||!base){
    // This is a proven pre-publication failure. Persist the original result so
    // a lost response never turns it into an indefinitely unknown operation.
    const failed=(await db.query(`INSERT INTO operations_system_general_publications_v1(endpoint,operation_id,operator_id,input,publication_id,result,created_at)
     VALUES($1,$2,$3,$4,NULL,$5,$6) RETURNING *`,[this.endpoint,data.operationId,actor.operatorId,JSON.stringify(data),
      JSON.stringify({code:'system_settings_source_changed'}),iso(this.now()*1000)])).rows[0];
    await this.fresh(operator,authorize,db);return this.result(db,failed);
   }
   const snapshot=contentSnapshotSchema.parse({...base.snapshot,settings:data.settings});
   // Reuse the actual publication service in this same pinned transaction.
   // Its own transaction wrapper is supplied the already pinned connection.
   const scoped=Object.assign(Object.create(this.contentPublications),{db:{query:(...args)=>db.query(...args),transaction:fn=>fn(db)},
    require:(current,write=false,connection=db)=>this.require(current,write?'system.settings.apply':'system.settings.read',connection)});
   const requested=await scoped.request(actor,{operationId:data.operationId,snapshot});
   await db.query('UPDATE site_publications_v1 SET base_publication_id=$3 WHERE endpoint=$1 AND id=$2',[this.endpoint,data.operationId,data.expectedPublicationId]);
   const row=(await db.query('INSERT INTO operations_system_general_publications_v1(endpoint,operation_id,operator_id,input,publication_id,created_at) VALUES($1,$2,$3,$4,$2,$5) RETURNING *',
    [this.endpoint,data.operationId,actor.operatorId,JSON.stringify(data),iso(this.now()*1000)])).rows[0];
   await this.fresh(operator,authorize,db);return this.result(db,row,requested.publication);
  });
 }
 same(row,operator,input){if(row.operator_id!==operator.operatorId||!isDeepStrictEqual(row.input,input))fail('system_settings_operation_changed');}
 async result(db,row,supplied=null){
  const publication=supplied??(row.publication_id?(await db.query('SELECT state,error,created_at,updated_at FROM site_publications_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,row.publication_id])).rows[0]:null);
  const code=row.result?.code==='system_settings_source_changed'||publication?.error?.code==='site_publication_base_changed'?'system_settings_source_changed':null;
  const state=code?'failed':publication?.state==='published'?'completed':publication?.state==='failed'?'failed':publication?'accepted':'unknown';
  return{state:'recorded',operationId:row.operation_id,operation:{operationId:row.operation_id,section:'general',kind:'apply',state,
   versionId:row.input.versionId,revision:row.input.settingsRevision,
   phases:[{target:'public-website',state:state==='completed'?'completed':state==='failed'?'failed':state==='unknown'?'unknown':'running',
    code,adoptedVersionId:state==='completed'?row.input.versionId:null}],startedAt:iso(row.created_at),
   finishedAt:['completed','failed'].includes(state)?iso(publication?.updated_at??publication?.updatedAt??row.created_at):null},...this.envelope()};
 }
 async operation(operator,id){
  const operationId=parseSystemSettings(systemSettingsUuidSchema,id);await this.require(operator,'system.settings.read');
  const row=(await this.db.query('SELECT * FROM operations_system_general_publications_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
  if(row&&row.operator_id!==operator.operatorId)fail('system_settings_permission_denied',403);
  const result=row?await this.result(this.db,row):{state:'not-recorded',operationId,operation:null,...this.envelope()};
  await this.require(operator,'system.settings.read');return result;
 }
}
