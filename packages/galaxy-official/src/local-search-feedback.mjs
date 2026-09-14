import * as z from 'zod/v4';
import { createHash } from 'node:crypto';
import { withLocalWrite,withLocalRead } from '../../galaxy-core/src/storage/write-lock.mjs';
import { localPaths,readJson,writeJson } from '../../galaxy-core/src/storage/files.mjs';
import { historyQuerySchema } from './shared/history-schema.mjs';
import { searchQuerySchema,searchSourceTypes } from './shared/search-schema.mjs';
import { feedbackItemSchema,feedbackVerdictSchema,feedbackListSchema,feedbackEditSchema,legacyFeedbackItem } from './shared/search-feedback-schema.mjs';
import { validatePublicUrl } from './public-fetch.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const endpointCheck=endpoint=>{if(validatePublicUrl(endpoint).origin!==endpoint)throw new Error('Canonical endpoint required.');};
const stripPage=({after:_after,limit:_limit,...criteria})=>criteria;
async function localState(directory,subjectId){
  const paths=localPaths(directory);
  if(await readJson(paths.initializationJournal,null)||await readJson(paths.resetJournal,null))throw new Error('Local recovery required.');
  const identity=await readJson(paths.identity,null),state=await readJson(paths.state,null);
  if(!identity?.id||subjectId&&identity.id!==subjectId||!state?.integration)throw new Error('Local feedback identity changed.');
  return {paths,state,subjectId:identity.id};
}
const keyFor=(endpoint,subjectId,criteria,item)=>hash([endpoint,subjectId,criteria,item.sourceId,...(item.sourceType==='history'?[]:[item.sourceType])]);
function normalize(row){
  if(row.version!==1&&row.version!==2||row.localOnly!==true||row.verificationEffect!=='none')throw new Error('Invalid feedback entry');
  const item=row.version===1?legacyFeedbackItem(row):feedbackItemSchema.parse(Object.fromEntries(
    ['sourceType','sourceId','sourceVersion','snapshotHash','caseId','projectionHash'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]])));
  const criteria=stripPage(item.sourceType==='history'?historyQuerySchema.parse(row.criteria):searchQuerySchema.parse({type:item.sourceType,query:row.criteria}).query);
  const verdict=feedbackVerdictSchema.parse({relevance:row.relevance,helpedSelection:row.helpedSelection});
  return {item,criteria,verdict,revision:z.number().int().positive().parse(row.revision??1),updatedAt:z.iso.datetime().parse(row.updatedAt)};
}

// Explicit local feedback: source/version hashes only, never retrieved content.
export async function saveLocalSearchFeedback(dataDirectory,{endpoint,subjectId,query,item,verdict,assertCurrent}){
  endpointCheck(endpoint);
  const source=item.sourceType?feedbackItemSchema.parse(item):legacyFeedbackItem(item);
  const criteria=stripPage(source.sourceType==='history'?historyQuerySchema.parse(query):searchQuerySchema.parse({type:source.sourceType,query}).query);
  const decision=verdict===null?null:feedbackVerdictSchema.parse(verdict),id=keyFor(endpoint,subjectId,criteria,source);
  return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state}=await localState(directory,subjectId);
    if(assertCurrent&&!await assertCurrent(directory))throw new Error('Current search result changed.');
    state.searchFeedback??={};const previous=state.searchFeedback[id];
    const revision=(previous?.revision??(previous?1:0))+1;
    if(!decision)delete state.searchFeedback[id];
    else{
      if(!previous&&Object.keys(state.searchFeedback).length>=10000)throw new Error('Local feedback capacity reached.');
      state.searchFeedback[id]={version:2,endpoint,subjectId,criteria,...source,...decision,revision,
        updatedAt:new Date().toISOString(),localOnly:true,verificationEffect:'none'};
    }
    await writeJson(paths.state,state);
    return {id,revision,state:decision?'saved-locally':'removed-locally',verificationEffect:'none'};
  });
}
export async function readLocalSearchFeedback(dataDirectory,{endpoint,...input}){
  endpointCheck(endpoint);const selection=feedbackListSchema.parse(input);
  return withLocalRead(dataDirectory,async directory=>{
    const {state,subjectId}=await localState(directory),records=[];let unreadableEntries=0;
    for(const [id,row] of Object.entries(state.searchFeedback??{})){
      if(row?.endpoint!==endpoint||row?.subjectId!==subjectId)continue;
      try{
        if(!/^[a-f0-9]{64}$/.test(id))throw new Error();const value=normalize(row);
        if(keyFor(endpoint,subjectId,value.criteria,value.item)!==id)throw new Error();
        if(selection.sourceType&&value.item.sourceType!==selection.sourceType)continue;
        records.push({id,...value.item,criteria:value.criteria,...value.verdict,revision:value.revision,updatedAt:value.updatedAt});
      }catch{unreadableEntries++;}
    }
    records.sort((a,b)=>a.id.localeCompare(b.id));
    const count=rows=>({responses:rows.length,relevance:{relevant:rows.filter(r=>r.relevance==='relevant').length,
      notRelevant:rows.filter(r=>r.relevance==='not-relevant').length,unsure:rows.filter(r=>r.relevance==='unsure').length},
      helpedSelection:{yes:rows.filter(r=>r.helpedSelection===true).length,no:rows.filter(r=>r.helpedSelection===false).length,unanswered:rows.filter(r=>r.helpedSelection===null).length}});
    const remaining=records.filter(row=>!selection.after||row.id>selection.after),items=remaining.slice(0,selection.limit);
    return {version:1,endpoint,subjectId,localOnly:true,verificationEffect:'none',sourceValidity:'not-rechecked',
      summary:{...count(records),sources:new Set(records.map(r=>r.sourceType+':'+r.sourceId)).size,
        queries:new Set(records.map(r=>hash([r.sourceType,r.criteria]))).size,
        bySource:Object.fromEntries(searchSourceTypes.map(type=>[type,count(records.filter(r=>r.sourceType===type))])),
        scope:'current-local-user; selected-endpoint-and-source-type',unreadableEntries},
      items,nextCursor:remaining.length>selection.limit?items.at(-1).id:null};
  });
}
export async function editLocalSearchFeedback(dataDirectory,{endpoint,assertCurrent,...input}){
  endpointCheck(endpoint);const selected=feedbackEditSchema.parse(input);
  return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state,subjectId}=await localState(directory),row=state.searchFeedback?.[selected.id];
    if(!row||row.subjectId!==subjectId||row.endpoint!==endpoint)throw new Error('Feedback entry unavailable.');
    const current=normalize(row);
    if(current.revision!==selected.revision||keyFor(endpoint,subjectId,current.criteria,current.item)!==selected.id)throw new Error('Feedback entry changed.');
    if(assertCurrent&&!assertCurrent())throw new Error('Local feedback closed.');
    if(selected.verdict===null)delete state.searchFeedback[selected.id];
    else state.searchFeedback[selected.id]={version:2,endpoint,subjectId,criteria:current.criteria,...current.item,...selected.verdict,
      revision:current.revision+1,updatedAt:new Date().toISOString(),localOnly:true,verificationEffect:'none'};
    await writeJson(paths.state,state);
    return {state:selected.verdict===null?'removed-locally':'saved-locally',verificationEffect:'none'};
  });
}
