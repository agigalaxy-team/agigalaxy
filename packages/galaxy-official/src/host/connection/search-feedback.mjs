import {captureSearchFeedbackItem,legacyFeedbackItem} from "../../shared/search-feedback-schema.mjs";
import {searchScope} from "../../shared/search-schema.mjs";

// Explicit feedback remains bound to the currently shown page and current session lease.
// The shared accessors remain live after every await; no session or operation is snapshotted.
export function createHostSearchFeedback({searchClient,busy,saveSearchFeedback,sessions,endpoint,historyClient,controllerState}){
  async function querySearch(input){
    if(!searchClient||busy())throw new Error('Search unavailable.');
    controllerState.feedbackPage=null;const operation=new AbortController(),version=controllerState.generation;controllerState.checking=operation;
    try{
      const identity=await feedbackIdentity();
      const result=await searchClient.query(input,{signal:operation.signal});
      if(saveSearchFeedback)await rememberFeedback(identity,input.type,input.query,result.items.map(item=>[item.id,captureSearchFeedbackItem(input.type,item)]),version,operation);
      if(version!==controllerState.generation||controllerState.checking!==operation)throw new Error('Search canceled.');return result;
    }
    finally{if(controllerState.checking===operation)controllerState.checking=null;}
  }
  async function feedbackIdentity(){
    if(!saveSearchFeedback)return null;
    const lease=sessions.readAuthorization?await sessions.readAuthorization(endpoint):null;
    const state=lease?{...lease,state:'session-local'}:await sessions.status(endpoint);
    return {subjectId:state.subjectId,bindingId:state.bindingId,lease};
  }
  async function rememberFeedback(identity,type,query,items,version,operation){
    if(!saveSearchFeedback)return;
    const state=await sessions.status(endpoint);
    if(version!==controllerState.generation||controllerState.checking!==operation||state.state!=='session-local'||!state.scopes?.includes(searchScope(type))
      ||!identity.subjectId||identity.subjectId!==state.subjectId||identity.bindingId!==state.bindingId
      ||identity.lease&&!sessions.matchesAuthorization(identity.lease))throw new Error('Current search session required.');
    controllerState.feedbackPage={...identity,type,query:structuredClone(query),items:new Map(items)};
  }
  async function queryHistory(input) {
    if (!historyClient || busy()) throw new Error('History query unavailable.');
    controllerState.feedbackPage = null;
    const operation = new AbortController(), version = controllerState.generation;
    controllerState.checking = operation;
    try {
      const identity = await feedbackIdentity();
      const result = await historyClient.query(input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('History query canceled.');
      if (saveSearchFeedback) await rememberFeedback(identity,'history',input,result.items.map(item=>[item.caseId,legacyFeedbackItem(item)]),version,operation);
      return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function recordSearchFeedback(caseId, verdict) {
    const page = controllerState.feedbackPage, version = controllerState.generation;
    if (!saveSearchFeedback || busy() || !page?.items.has(caseId)) throw new Error('Current search result required.');
    const state = await sessions.status(endpoint);
    const assertCurrent=()=>version===controllerState.generation&&controllerState.feedbackPage===page&&(!page.lease||sessions.matchesAuthorization(page.lease));
    if (!assertCurrent() || state.state !== 'session-local' || !state.scopes?.includes(searchScope(page.type))
      ||state.subjectId!==page.subjectId||state.bindingId!==page.bindingId)
      throw new Error('Current search session required.');
    return saveSearchFeedback({ endpoint, subjectId: page.subjectId, query: page.query, item: page.items.get(caseId), verdict, assertCurrent });
  }
  return Object.freeze({querySearch,queryHistory,recordSearchFeedback});
}
