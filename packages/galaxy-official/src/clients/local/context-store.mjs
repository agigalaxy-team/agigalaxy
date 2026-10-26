import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { withLocalRead,withLocalWrite } from "../../../../galaxy-core/src/storage/write-lock.mjs";
import { localPaths,readJson,writeJson } from "../../../../galaxy-core/src/storage/files.mjs";
import { verifyGalaxyGenesis } from "../../../../galaxy-core/src/galaxy-guid.mjs";
import { contextDraftContentSchema,contextDraftSource,sameContextSource,grantFromDraft } from "../../shared/context-draft.mjs";
import { contextGrantSchema,contextAcceptanceSchema } from "../../shared/context-schema.mjs";
import { consentSchema } from "../../shared/consents-schema.mjs";
import { validatePublicUrl } from "../../infrastructure/public-fetch.mjs";
import { readLocalContextExcerpt } from "./context-file.mjs";
const hash=text=>createHash('sha256').update(text).digest('hex');
const parse=text=>{
  if(typeof text!=='string'||Buffer.byteLength(text)>16000)throw new Error('Invalid Context payload.');
  const raw=JSON.parse(text);return (raw.grantId?contextAcceptanceSchema:contextGrantSchema).parse(raw);
};
export function createLocalContextStore({dataDirectory,endpoint,assertOpen=()=>true}){
  if(validatePublicUrl(endpoint).origin!==endpoint)throw new Error('Canonical Context endpoint required.');
  const key=(subjectId,id)=>hash(JSON.stringify([endpoint,subjectId,id]));
  async function load(directory,subjectId){
    const paths=localPaths(directory),identity=await readJson(paths.identity,null),state=await readJson(paths.state,null);
    if(await readJson(paths.initializationJournal,null)||await readJson(paths.resetJournal,null))throw new Error('Local recovery required.');
    if(!assertOpen()||!identity||subjectId&&identity.id!==subjectId||!verifyGalaxyGenesis(identity.id,identity.genesisProof)||!state?.integration)
      throw new Error('Local Context identity unavailable.');
    state.contextDrafts??={};state.contextOperations??={};return {paths,identity,state};
  }
  async function write(paths,state){
    const local=[state.contextDrafts,state.contextOperations];
    if(local.some(rows=>Object.keys(rows).length>100)||Buffer.byteLength(JSON.stringify(local))>2097152
      ||Buffer.byteLength(JSON.stringify(state,null,2))+1>4194304)throw new Error('Local Context storage full; remove completed local records.');
    if(!assertOpen())throw new Error('Local host closed.');await writeJson(paths.state,state);
  }
  function draft(row,subjectId){
    if(row?.version!==1||row.endpoint!==endpoint||row.subjectId!==subjectId||!z.uuid().safeParse(row.id).success
      ||!Number.isInteger(row.revision)||row.revision<1||!['editing','prepared'].includes(row.status))throw new Error('Invalid Context draft.');
    contextDraftContentSchema.parse(row.content);
    if(row.content.source.ownerId!==subjectId)throw new Error('Context draft owner mismatch.');return row;
  }
  function operation(row,subjectId){
    if(row?.version!==1||row.endpoint!==endpoint||row.subjectId!==subjectId)throw new Error('Context journal identity mismatch.');
    const payload=parse(row.payloadJson),kind=payload.grantId?'accept':'grant';
    if(row.kind!==kind||row.eventId!==payload.id||row.grantId!==(payload.grantId??payload.id)||row.payloadHash!==hash(row.payloadJson)
      ||!Array.isArray(row.intents)||!row.intents.length||row.intents.length>16
      ||!['prepared','submitting','unknown','conflict','acknowledged'].includes(row.status))throw new Error('Invalid Context journal.');
    for(const raw of row.intents){const intent=consentSchema.parse(raw);
      if(intent.subjectId!==subjectId||intent.endpoint!==endpoint||intent.recipient!==endpoint||intent.objectId!==payload.id
        ||intent.action!=='context.grant'||intent.visibility!=='Private'||intent.viewers.length!==1||intent.payloadHash!==row.payloadHash
        ||JSON.stringify(intent.fields)!==JSON.stringify(Object.keys(payload))||kind==='grant'&&intent.viewers[0]!==payload.participantId)
        throw new Error('Context journal Consent mismatch.');}
    return row;
  }
  async function createDraft(record){const source=contextDraftSource(record);
    return withLocalWrite(dataDirectory,async directory=>{
      const {paths,state,identity}=await load(directory,source.ownerId),id=randomUUID(),at=new Date().toISOString();
      const row=draft({version:1,id,endpoint,subjectId:identity.id,revision:1,status:'editing',createdAt:at,updatedAt:at,
        content:{source,materials:[{id:randomUUID(),label:'',content:''}],hours:'1',step:'label',index:0}},identity.id);
      state.contextDrafts[key(identity.id,id)]=row;await write(paths,state);return row;
    });
  }
  async function getDraft(id){return withLocalRead(dataDirectory,async directory=>{
    const {state,identity}=await load(directory);return draft(state.contextDrafts[key(identity.id,id)],identity.id);
  });}
  async function previewFile({id,expectedRevision,path,startLine,endLine}){
    const row=await getDraft(id);
    if(row.status!=='editing'||row.revision!==expectedRevision)throw new Error('Context draft changed; reopen it.');
    const selection=await readLocalContextExcerpt({path,startLine,endLine}),current=await getDraft(id);
    if(current.subjectId!==row.subjectId||current.status!=='editing'||current.revision!==expectedRevision)
      throw new Error('Context draft changed; reopen it.');
    return selection;
  }
  async function saveDraft({id,expectedRevision,content}){const parsed=contextDraftContentSchema.parse(content);
    return withLocalWrite(dataDirectory,async directory=>{
      const {paths,state,identity}=await load(directory),row=draft(state.contextDrafts[key(identity.id,id)],identity.id);
      if(row.status!=='editing'||row.revision!==expectedRevision)throw new Error('Context draft changed; reopen it.');
      if(!sameContextSource(row.content.source,parsed.source))throw new Error('Context recipient and scope require explicit review.');
      row.content=parsed;row.revision++;row.updatedAt=new Date().toISOString();await write(paths,state);return row;
    });
  }
  async function rebaseDraft({id,expectedRevision,record}){const source=contextDraftSource(record);
    return withLocalWrite(dataDirectory,async directory=>{
      const {paths,state,identity}=await load(directory,source.ownerId),row=draft(state.contextDrafts[key(identity.id,id)],identity.id);
      if(row.status!=='editing'||row.revision!==expectedRevision||row.content.source.assistanceId!==source.assistanceId)
        throw new Error('Context draft changed; reopen it.');
      row.content.source=source;row.revision++;row.updatedAt=new Date().toISOString();await write(paths,state);return row;
    });
  }
  async function listDrafts(){return withLocalRead(dataDirectory,async directory=>{
    const {state,identity}=await load(directory);
    return {endpoint,subjectId:identity.id,localOnly:true,items:Object.values(state.contextDrafts).filter(row=>row.subjectId===identity.id&&row.endpoint===endpoint).map(row=>{
      draft(row,identity.id);return {id:row.id,title:row.content.source.title,status:row.status,assistanceId:row.content.source.assistanceId,updatedAt:row.updatedAt};
    })};
  });}
  async function forgetDraft(id){return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state,identity}=await load(directory),row=draft(state.contextDrafts[key(identity.id,id)],identity.id);
    if(row.status!=='editing')throw new Error('Use the saved Context operation before removing this draft.');
    delete state.contextDrafts[key(identity.id,id)];await write(paths,state);return {id,remoteDeleted:false};
  });}
  async function save({subjectId,payloadJson,intent,draftId,draftRevision}){return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state}=await load(directory,subjectId),payload=parse(payloadJson),id=key(subjectId,payload.id),previous=state.contextOperations[id];
    if(previous){operation(previous,subjectId);if(previous.payloadJson!==payloadJson)throw new Error('Context payload already frozen.');if(previous.status==='acknowledged')return previous;}
    if(draftId){
      const row=draft(state.contextDrafts[key(subjectId,draftId)],subjectId);
      if(row.status!=='editing'||row.revision!==draftRevision||JSON.stringify(payload)!==JSON.stringify(grantFromDraft(row,payload.expiresAt)))
        throw new Error('Context draft changed; reopen it.');
      row.status='prepared';row.revision++;row.updatedAt=new Date().toISOString();
    }
    const intents=previous?.intents??[];
    if(intents.some(item=>item.id===intent.id&&JSON.stringify(item)!==JSON.stringify(intent)))throw new Error('Context Consent already frozen.');
    const row=operation({version:1,endpoint,subjectId,eventId:payload.id,grantId:payload.grantId??payload.id,kind:payload.grantId?'accept':'grant',
      payloadJson,payloadHash:hash(payloadJson),draftId:previous?.draftId??draftId??null,intents:intents.some(item=>item.id===intent.id)?intents:[...intents,intent],
      status:previous?.status??'prepared',createdAt:previous?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString()},subjectId);
    state.contextOperations[id]=row;await write(paths,state);return row;
  });}
  async function get(eventId){return withLocalRead(dataDirectory,async directory=>{
    const {state,identity}=await load(directory),row=state.contextOperations[key(identity.id,eventId)];return row?operation(row,identity.id):null;
  });}
  async function list(){return withLocalRead(dataDirectory,async directory=>{
    const {state,identity}=await load(directory);
    return {endpoint,subjectId:identity.id,localOnly:true,items:Object.values(state.contextOperations).filter(row=>row.subjectId===identity.id&&row.endpoint===endpoint)
      .map(row=>{operation(row,identity.id);return {eventId:row.eventId,grantId:row.grantId,kind:row.kind,status:row.status,updatedAt:row.updatedAt};})};
  });}
  async function mark(eventId,subjectId,status,receipt){return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state}=await load(directory,subjectId),row=operation(state.contextOperations[key(subjectId,eventId)],subjectId);
    if(row.status==='acknowledged')return row;
    if(!['submitting','unknown','conflict','acknowledged'].includes(status))throw new Error('Invalid Context outcome.');
    if(status==='acknowledged'){
      if(receipt?.grantId!==row.grantId||receipt.eventId!==row.eventId||receipt.kind!==row.kind||receipt.payloadHash!==row.payloadHash
        ||!row.intents.some(intent=>intent.id===receipt.consentId))throw new Error('Context receipt does not match frozen event.');
      row.receipt={grantId:row.grantId,eventId,kind:row.kind,payloadHash:row.payloadHash,consentId:receipt.consentId};
    }
    row.status=status;row.updatedAt=new Date().toISOString();await write(paths,state);return row;
  });}
  async function forget(eventId){return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state,identity}=await load(directory),id=key(identity.id,eventId),row=operation(state.contextOperations[id],identity.id);
    if(!['prepared','acknowledged'].includes(row.status))throw new Error('Reconcile an uncertain Context outcome before removing its local record.');
    delete state.contextOperations[id];if(row.draftId)delete state.contextDrafts[key(identity.id,row.draftId)];
    await write(paths,state);return {eventId,remoteDeleted:false};
  });}
  return Object.freeze({createDraft,getDraft,previewFile,saveDraft,rebaseDraft,listDrafts,forgetDraft,save,get,list,mark,forget});
}
