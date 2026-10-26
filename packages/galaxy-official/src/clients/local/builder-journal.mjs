import { createHash } from 'node:crypto';
import { withLocalRead,withLocalWrite } from "../../../../galaxy-core/src/storage/write-lock.mjs";
import { localPaths,readJson,writeJson } from "../../../../galaxy-core/src/storage/files.mjs";
import { verifyGalaxyGenesis } from "../../../../galaxy-core/src/galaxy-guid.mjs";
import { builderEventSchema } from "../../shared/builders-schema.mjs";
import { consentSchema } from "../../shared/consents-schema.mjs";
import { validatePublicUrl } from "../../infrastructure/public-fetch.mjs";

const hash=text=>createHash('sha256').update(text).digest('hex');
export function createLocalBuilderJournal({dataDirectory,endpoint,assertOpen=()=>true}){
  if(validatePublicUrl(endpoint).origin!==endpoint)throw new Error('Canonical Builder endpoint required.');
  const key=(subjectId,eventId)=>hash(JSON.stringify([endpoint,subjectId,eventId]));
  async function load(directory,subjectId){
    const paths=localPaths(directory),identity=await readJson(paths.identity,null),state=await readJson(paths.state,null);
    if(await readJson(paths.initializationJournal,null)||await readJson(paths.resetJournal,null))throw new Error('Local recovery required.');
    if(!assertOpen()||!identity||subjectId&&identity.id!==subjectId||!verifyGalaxyGenesis(identity.id,identity.genesisProof)||!state?.integration)throw new Error('Local Builder identity unavailable.');
    return {paths,identity,state};
  }
  function normalize(record,subjectId){
    if(record?.version!==1||record.endpoint!==endpoint||record.subjectId!==subjectId)throw new Error('Builder journal identity mismatch.');
    const payload=builderEventSchema.parse(JSON.parse(record.payloadJson));
    if(record.eventId!==payload.id||record.builderId!==payload.builderId||record.payloadHash!==hash(record.payloadJson)
      ||!Array.isArray(record.intents)||!record.intents.length||record.intents.length>16)throw new Error('Invalid Builder journal.');
    for(const raw of record.intents){const intent=consentSchema.parse(raw);
      if(intent.subjectId!==subjectId||intent.endpoint!==endpoint||intent.recipient!==endpoint||intent.action!=='builder.publish'||intent.objectId!==payload.id
        ||intent.payloadHash!==record.payloadHash||JSON.stringify(intent.fields)!==JSON.stringify(Object.keys(payload)))throw new Error('Builder journal Consent mismatch.');}
    if(!['prepared','submitting','unknown','conflict','acknowledged'].includes(record.status))throw new Error('Invalid Builder journal state.');
    return record;
  }
  const bounded=state=>{if(Object.keys(state.builderOperations).length>100||Buffer.byteLength(JSON.stringify(state.builderOperations))>2097152||Buffer.byteLength(JSON.stringify(state))>4194304)throw new Error('Local Builder journal full; remove completed local records.');};
  async function save({subjectId,payloadJson,intent}){return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state}=await load(directory,subjectId),payload=builderEventSchema.parse(JSON.parse(payloadJson)),id=key(subjectId,payload.id);
    state.builderOperations??={};const previous=state.builderOperations[id];
    if(previous){normalize(previous,subjectId);if(previous.payloadJson!==payloadJson)throw new Error('Builder event payload already frozen.');if(previous.status==='acknowledged')return previous;}
    const intents=previous?.intents??[];
    if(intents.some(item=>item.id===intent.id&&JSON.stringify(item)!==JSON.stringify(intent)))throw new Error('Builder Consent already frozen.');
    const record=normalize({version:1,endpoint,subjectId,eventId:payload.id,builderId:payload.builderId,payloadJson,payloadHash:hash(payloadJson),
      intents:intents.some(item=>item.id===intent.id)?intents:[...intents,intent],status:previous?.status??'prepared',createdAt:previous?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString()},subjectId);
    state.builderOperations[id]=record;bounded(state);await writeJson(paths.state,state);return record;
  });}
  async function get(eventId){return withLocalRead(dataDirectory,async directory=>{
    const {identity,state}=await load(directory),record=state.builderOperations?.[key(identity.id,eventId)];
    return record?normalize(record,identity.id):null;
  });}
  async function list(){return withLocalRead(dataDirectory,async directory=>{
    const {identity,state}=await load(directory),items=[];
    for(const record of Object.values(state.builderOperations??{})){
      if(record.endpoint!==endpoint||record.subjectId!==identity.id)continue;
      const row=normalize(record,identity.id),payload=JSON.parse(row.payloadJson);
      items.push({eventId:row.eventId,builderId:row.builderId,kind:payload.kind,action:payload.action??null,status:row.status,updatedAt:row.updatedAt});
    }
    return {endpoint,subjectId:identity.id,items,localOnly:true};
  });}
  async function mark(eventId,subjectId,status,receipt=null){return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state}=await load(directory,subjectId),record=normalize(state.builderOperations?.[key(subjectId,eventId)],subjectId);
    if(record.status==='acknowledged')return record;
    if(!['submitting','unknown','conflict','acknowledged'].includes(status))throw new Error('Invalid Builder outcome.');
    if(status==='acknowledged'){
      if(receipt?.builderId!==record.builderId||receipt.eventId!==eventId||receipt.revision!==JSON.parse(record.payloadJson).expectedRevision+1
        ||!record.intents.some(intent=>intent.id===receipt.consentId)||receipt.payloadHash!==record.payloadHash)throw new Error('Builder receipt does not match frozen event.');
      record.receipt={builderId:record.builderId,eventId,revision:receipt.revision,consentId:receipt.consentId,payloadHash:record.payloadHash};
    }
    record.status=status;record.updatedAt=new Date().toISOString();await writeJson(paths.state,state);return record;
  });}
  async function forget(eventId){return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state,identity}=await load(directory),id=key(identity.id,eventId),record=normalize(state.builderOperations?.[id],identity.id);
    if(!['prepared','acknowledged'].includes(record.status))throw new Error('Reconcile an uncertain Builder outcome before removing its local record.');
    delete state.builderOperations[id];await writeJson(paths.state,state);return {state:'local-record-removed',eventId,remoteDeleted:false};
  });}
  return Object.freeze({save,get,list,mark,forget});
}
