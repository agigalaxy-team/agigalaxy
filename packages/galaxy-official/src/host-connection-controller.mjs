import { captureSearchFeedbackItem, legacyFeedbackItem } from './shared/search-feedback-schema.mjs';
import { searchScope } from './shared/search-schema.mjs';

// Trusted composition only. No configuration discovery or implicit remote I/O.
export function createHostConnectionController({ client, sessions, endpoint, readRequest, statusClient, bindingManagementClient, identityClient, historyClient, searchClient, projectDiscoveryClient, profileFlow, caseReviewFlow, caseClient, assistanceClient, assistanceFlow, contextClient, contextFlow, notificationsClient, honorClient, capsuleClient, capsuleFlow, builderClient, builderFlow, nodeControlProofFlow, auditClient, deletionClient, deletionStatusClient, dataExportClient, saveExportToDirectory, moderationClient, moderationFlow, publicationFlow, saveSearchFeedback, a2aFlow }) {
  let activeIdentity=null;
  let activeBindingRevoke=null;
  let activeNodeProof=null;
  let activeCaseReview=null;
  let activeProfile=null;
  let activeA2a = null;
  let activeAudit = null;
  let activeDeletionStatus = null;
  let activeDeletion = null;
  let active = null, activeCase = null, activeAssistance = null, activeCollaboration = null, activeContext = null, activeModeration = null, activeCapsule = null, activeBuilder = null, activePublication = null, generation = 0, preparing = false, checking = null;
  const busy = () => activeIdentity || activeBindingRevoke || active || activeNodeProof || activeCaseReview || activeProfile || activeCase || activeAssistance || activeCollaboration || activeContext || activeModeration || activeCapsule || activeBuilder || activePublication || activeA2a || activeAudit || activeDeletion || activeDeletionStatus || preparing || checking;
  let feedbackPage = null;
  async function prepare() {
    if (busy()) throw new Error('Connection operation already active.');
    preparing = true;
    const version = generation;
    try {
      const request = await readRequest();
      if (version !== generation) throw new Error('Connection preparation canceled.');
      active = client.prepare(request);
      return active;
    } finally { preparing = false; }
  }
  async function execute(preview, confirmation) {
    if (active !== preview) throw new Error('Unknown host connection preview.');
    const version = generation;
    try {
      const result = await client.execute(preview, confirmation);
      if (version !== generation || active !== preview) {
        result.takeCredential(); // discard; never serialize a late success
        throw new Error('Connection operation canceled.');
      }
      sessions.adopt(result);
      const status = await sessions.status(endpoint);
      if (version !== generation || active !== preview) throw new Error('Connection operation canceled.');
      active = null;
      return status;
    } catch (error) {
      if (active === preview) {
        active = null;
        sessions.invalidate(endpoint, 'remote-outcome-unknown');
      }
      throw error;
    }
  }
  async function checkRemote() {
    if (!statusClient || busy()) throw new Error('Remote check unavailable.');
    const operation = new AbortController(), version = generation;
    checking = operation;
    try {
      const result = await statusClient.check({ signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Remote check canceled.');
      return result;
    } finally { if (checking === operation) checking = null; }
  }
  function cancel() {
    if(activeIdentity)identityClient.cancel(activeIdentity);activeIdentity=null;
    if(activeBindingRevoke)bindingManagementClient.cancel(activeBindingRevoke);activeBindingRevoke=null;
    if(activeCaseReview)caseReviewFlow.cancel(activeCaseReview);activeCaseReview=null;
    if(activeProfile)profileFlow.cancel(activeProfile);
    activeProfile=null;
    generation++;
    feedbackPage = null;
    checking?.abort(); checking = null;
    if (activeDeletionStatus) deletionStatusClient.cancel(activeDeletionStatus);
    activeDeletionStatus = null;
    if (activeDeletion) deletionClient.cancel(activeDeletion);
    activeDeletion = null;
    if (activeAudit) auditClient.cancel(activeAudit);
    activeAudit = null;
    if (active) { client.cancel(active); sessions.invalidate(endpoint, 'disconnected'); }
    if (activeCase) caseClient.cancel(activeCase);
    activeCase = null;
    if (activeAssistance) assistanceClient.cancel(activeAssistance);
    activeAssistance = null;
    if (activeCollaboration) assistanceFlow.cancel(activeCollaboration);
    activeCollaboration = null;
    if (activeContext) contextFlow.cancel(activeContext);
    activeContext = null;
    if (activeModeration) moderationFlow.cancel(activeModeration);
    activeModeration = null;
    if (activeBuilder) builderFlow.cancel(activeBuilder);
    activeBuilder = null;
    if(activeNodeProof)nodeControlProofFlow.cancel(activeNodeProof);
    activeNodeProof=null;
    if (activeCapsule) capsuleFlow.cancel(activeCapsule);
    activeCapsule = null;
    if (activePublication) publicationFlow.cancel(activePublication);
    activePublication = null;
    if (activeA2a) a2aFlow.cancel(activeA2a);
    activeA2a = null;
    active = null;
  }
  async function querySearch(input){
    if(!searchClient||busy())throw new Error('Search unavailable.');
    feedbackPage=null;const operation=new AbortController(),version=generation;checking=operation;
    try{
      const identity=await feedbackIdentity();
      const result=await searchClient.query(input,{signal:operation.signal});
      if(saveSearchFeedback)await rememberFeedback(identity,input.type,input.query,result.items.map(item=>[item.id,captureSearchFeedbackItem(input.type,item)]),version,operation);
      if(version!==generation||checking!==operation)throw new Error('Search canceled.');return result;
    }
    finally{if(checking===operation)checking=null;}
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
    if(version!==generation||checking!==operation||state.state!=='session-local'||!state.scopes?.includes(searchScope(type))
      ||!identity.subjectId||identity.subjectId!==state.subjectId||identity.bindingId!==state.bindingId
      ||identity.lease&&!sessions.matchesAuthorization(identity.lease))throw new Error('Current search session required.');
    feedbackPage={...identity,type,query:structuredClone(query),items:new Map(items)};
  }
  async function queryHistory(input) {
    if (!historyClient || busy()) throw new Error('History query unavailable.');
    feedbackPage = null;
    const operation = new AbortController(), version = generation;
    checking = operation;
    try {
      const identity = await feedbackIdentity();
      const result = await historyClient.query(input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('History query canceled.');
      if (saveSearchFeedback) await rememberFeedback(identity,'history',input,result.items.map(item=>[item.caseId,legacyFeedbackItem(item)]),version,operation);
      return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareProfile(input){
    if(!profileFlow||busy())throw new Error('Profile preparation unavailable.');
    preparing=true;const version=generation;
    try{
      const preview=await profileFlow.prepare(input);
      if(version!==generation){profileFlow.cancel(preview);throw new Error('Profile preparation canceled.');}
      activeProfile=preview;return preview;
    }finally{preparing=false;}
  }
  async function prepareCaseReview(input){
    if(!caseReviewFlow||busy())throw new Error('Case review preparation unavailable.');
    preparing=true;const version=generation;
    try{
      const preview=await caseReviewFlow.prepare(input);
      if(version!==generation){caseReviewFlow.cancel(preview);throw new Error('Case review preparation canceled.');}
      activeCaseReview=preview;return preview;
    }finally{preparing=false;}
  }
  async function executeCaseReview(preview,confirmation){
    if(!activeCaseReview||activeCaseReview!==preview)throw new Error('Unknown Case review preview.');
    const version=generation;
    try{const result=await caseReviewFlow.execute(preview,confirmation);if(version!==generation)throw new Error('Case review canceled; check remote outcome.');return result;}
    finally{if(activeCaseReview===preview)activeCaseReview=null;}
  }
  async function executeProfile(preview,confirmation){
    if(!activeProfile||activeProfile!==preview)throw new Error('Unknown Profile preview.');
    const version=generation;
    try{
      const result=await profileFlow.execute(preview,confirmation);
      if(version!==generation)throw new Error('Profile canceled; check remote outcome.');return result;
    }finally{if(activeProfile===preview)activeProfile=null;}
  }
  function disconnect() { cancel(); sessions.invalidate(endpoint, 'disconnected'); }
  async function prepareCase(request) {
    if (!caseClient || busy()) throw new Error('Case preparation unavailable.');
    preparing = true;
    const version = generation;
    try {
      const state = await sessions.status(endpoint);
      if (version !== generation) throw new Error('Case preparation canceled.');
      if (state.state !== 'session-local' || !state.scopes?.includes('case-teaser')) throw new Error('Case authorization required.');
      activeCase = caseClient.prepare(request);
      return activeCase;
    } finally { preparing = false; }
  }
  async function executeCase(preview, confirmation) {
    if (!activeCase || activeCase !== preview) throw new Error('Unknown host Case preview.');
    const version = generation;
    try {
      const result = await caseClient.execute(preview, confirmation);
      if (version !== generation || activeCase !== preview) throw new Error('Case submission canceled; check remote outcome.');
      return result;
    } finally { if (activeCase === preview) activeCase = null; }
  }
  async function getCase(caseId) {
    if (!caseClient || busy()) throw new Error('Case read unavailable.');
    const operation = new AbortController(), version = generation;
    checking = operation;
    try {
      const result = await caseClient.get(caseId, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Case read canceled.');
      return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareAssistance(request) {
    if (!assistanceClient || busy()) throw new Error('Assistance preparation unavailable.');
    preparing = true;
    const version = generation;
    try {
      const state = await sessions.status(endpoint);
      if (version !== generation) throw new Error('Assistance preparation canceled.');
      if (state.state !== 'session-local' || !state.scopes?.includes('assistance')) throw new Error('Assistance authorization required.');
      activeAssistance = assistanceClient.prepare(request);
      return activeAssistance;
    } finally { preparing = false; }
  }
  async function executeAssistance(preview, confirmation) {
    if (!activeAssistance || activeAssistance !== preview) throw new Error('Unknown host Assistance preview.');
    const version = generation;
    try {
      const result = await assistanceClient.execute(preview, confirmation);
      if (version !== generation || activeAssistance !== preview) throw new Error('Assistance submission canceled; check remote outcome.');
      return result;
    } finally { if (activeAssistance === preview) activeAssistance = null; }
  }
  async function getAssistance(assistanceId) {
    if (!assistanceClient || busy()) throw new Error('Assistance read unavailable.');
    const operation = new AbortController(), version = generation;
    checking = operation;
    try {
      const result = await assistanceClient.get(assistanceId, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Assistance read canceled.');
      return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function queryAssistance(input) {
    if (!assistanceClient || busy()) throw new Error('Assistance query unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await assistanceClient.query(input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Assistance query canceled.');
      return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareCollaboration(input, retry = false) {
    if (!assistanceFlow || busy()) throw new Error('Collaboration preparation unavailable.');
    preparing = true; const version = generation;
    try {
      const preview = await assistanceFlow[retry ? 'prepareRetry' : 'prepare'](input);
      if (version !== generation) { assistanceFlow.cancel(preview); throw new Error('Collaboration preparation canceled.'); }
      activeCollaboration = preview; return preview;
    } finally { preparing = false; }
  }
  async function executeCollaboration(preview, confirmation) {
    if (!activeCollaboration || activeCollaboration !== preview) throw new Error('Unknown collaboration preview.');
    const version = generation;
    try {
      const receipt = await assistanceFlow.execute(preview, confirmation);
      if (version !== generation) throw new Error('Collaboration canceled; check remote outcome.');
      return receipt;
    } finally { if (activeCollaboration === preview) activeCollaboration = null; }
  }
  async function readContext(method, id) {
    if (!contextClient || busy()) throw new Error('Context read unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await contextClient[method](id, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Context read canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareContext(input, retry=false) {
    if (!contextFlow || busy()) throw new Error('Context preparation unavailable.');
    preparing = true; const version = generation;
    try {
      const preview = await contextFlow[retry?'prepareRetry':'prepare'](input);
      if (version !== generation) { contextFlow.cancel(preview); throw new Error('Context preparation canceled.'); }
      activeContext = preview; return preview;
    } finally { preparing = false; }
  }
  async function executeContext(preview, confirmation) {
    if (!activeContext || activeContext !== preview) throw new Error('Unknown Context preview.');
    const version = generation;
    try {
      const result = await contextFlow.execute(preview, confirmation);
      if (version !== generation) throw new Error('Context canceled; check remote outcome.'); return result;
    } finally { if (activeContext === preview) activeContext = null; }
  }
  async function readModeration(method, id) {
    if (!moderationClient || busy()) throw new Error('Moderation read unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await moderationClient[method](id, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Moderation read canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareModeration(input) {
    if (!moderationFlow || busy()) throw new Error('Moderation preparation unavailable.');
    preparing = true; const version = generation;
    try {
      const preview = await moderationFlow.prepare(input);
      if (version !== generation) { moderationFlow.cancel(preview); throw new Error('Moderation preparation canceled.'); }
      activeModeration = preview; return preview;
    } finally { preparing = false; }
  }
  async function executeModeration(preview, confirmation) {
    if (!activeModeration || activeModeration !== preview) throw new Error('Unknown Moderation preview.');
    const version = generation;
    try {
      const result = await moderationFlow.execute(preview, confirmation);
      if (version !== generation) throw new Error('Moderation canceled; check remote outcome.'); return result;
    } finally { if (activeModeration === preview) activeModeration = null; }
  }
  async function readCapsule(method, id) {
    if (!capsuleClient || busy()) throw new Error('Capsule read unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await capsuleClient[method](id, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Capsule read canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareCapsule(input) {
    if (!capsuleFlow || busy()) throw new Error('Capsule preparation unavailable.');
    preparing = true; const version = generation;
    try {
      const preview = await capsuleFlow.prepare(input);
      if (version !== generation) { capsuleFlow.cancel(preview); throw new Error('Capsule preparation canceled.'); }
      activeCapsule = preview; return preview;
    } finally { preparing = false; }
  }
  async function executeCapsule(preview, confirmation) {
    if (!activeCapsule || activeCapsule !== preview) throw new Error('Unknown Capsule preview.');
    const version = generation;
    try {
      const result = await capsuleFlow.execute(preview, confirmation);
      if (version !== generation) throw new Error('Capsule canceled; check remote outcome.'); return result;
    } finally { if (activeCapsule === preview) activeCapsule = null; }
  }
  async function readDataExport(method, input = {}) {
    if (!dataExportClient || busy() || !['specification', 'create', 'page', 'binary', 'revoke'].includes(method)) throw new Error('Data export operation unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await dataExportClient[method](input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Data export canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function saveDataExport(id, directory) {
    if (!saveExportToDirectory || busy()) throw new Error('Local export unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await saveExportToDirectory(id, directory, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Export canceled; inspect the selected local directory.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function readDeletion(method, input = {}) {
    if (!deletionClient || busy() || !['config','query','read'].includes(method)) throw new Error('Deletion operation unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await deletionClient[method](input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Deletion read canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareDeletion(input) {
    if (!deletionClient || busy()) throw new Error('Deletion request unavailable.');
    preparing = true; const version = generation;
    try { const preview = await deletionClient.prepare(input);
      if (version !== generation) { deletionClient.cancel(preview); throw new Error('Deletion preparation canceled.'); }
      activeDeletion = preview; return preview;
    } finally { preparing = false; }
  }
  async function executeDeletion(preview, confirmation) {
    if (!activeDeletion || activeDeletion !== preview) throw new Error('Unknown deletion request.');
    const version = generation;
    try { const result = await deletionClient.execute(preview, confirmation);
      if (version !== generation) throw new Error('Deletion submission canceled; inspect current requests.'); return result;
    } finally { if (activeDeletion === preview) activeDeletion = null; }
  }
  async function prepareDeletionStatus(input) {
    if (!deletionStatusClient || busy()) throw new Error('Deletion request unavailable.');
    preparing = true; const version = generation;
    try { const preview = await deletionStatusClient.prepare(input);
      if (version !== generation) { deletionStatusClient.cancel(preview); throw new Error('Deletion preparation canceled.'); }
      activeDeletionStatus = preview; return preview;
    } finally { preparing = false; }
  }
  async function executeDeletionStatus(preview, confirmation) {
    if (!activeDeletionStatus || activeDeletionStatus !== preview) throw new Error('Unknown deletion request.');
    const version = generation;
    try { const result = await deletionStatusClient.execute(preview, confirmation);
      if (version !== generation) throw new Error('Deletion submission canceled; inspect current requests.'); return result;
    } finally { if (activeDeletionStatus === preview) activeDeletionStatus = null; }
  }
  async function readAudit(method, input = {}) {
    if (!auditClient || busy()) throw new Error('Audit operation unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await auditClient[method](input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Audit read canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareAudit(input) {
    if (!auditClient || busy()) throw new Error('Audit approval unavailable.');
    preparing = true; const version = generation;
    try { const preview = await auditClient.prepare(input);
      if (version !== generation) { auditClient.cancel(preview); throw new Error('Audit preparation canceled.'); }
      activeAudit = preview; return preview;
    } finally { preparing = false; }
  }
  async function executeAudit(preview, confirmation) {
    if (!activeAudit || activeAudit !== preview) throw new Error('Unknown audit approval.');
    const version = generation;
    try { const result = await auditClient.execute(preview, confirmation);
      if (version !== generation) throw new Error('Audit approval canceled; inspect current grants.'); return result;
    } finally { if (activeAudit === preview) activeAudit = null; }
  }
  async function readBuilder(method, id) {
    if (!builderClient || busy()) throw new Error('Builder read unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await builderClient[method](id, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Builder read canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareBuilder(input,retry=false) {
    if (!builderFlow || busy()) throw new Error('Builder preparation unavailable.');
    preparing = true; const version = generation;
    try {
      const preview = await builderFlow[retry?'prepareRetry':'prepare'](input);
      if (version !== generation) { builderFlow.cancel(preview); throw new Error('Builder preparation canceled.'); }
      activeBuilder = preview; return preview;
    } finally { preparing = false; }
  }
  async function executeBuilder(preview, confirmation) {
    if (!activeBuilder || activeBuilder !== preview) throw new Error('Unknown Builder preview.');
    const version = generation;
    try {
      const result = await builderFlow.execute(preview, confirmation);
      if (version !== generation) throw new Error('Builder canceled; check remote outcome.'); return result;
    } finally { if (activeBuilder === preview) activeBuilder = null; }
  }
  async function contextOperation(method,id){
    if(!contextFlow?.[method]||busy())throw new Error('Context operation unavailable.');
    const operation=new AbortController(),version=generation;checking=operation;
    try{const result=await contextFlow[method](id,{signal:operation.signal});
      if(version!==generation||checking!==operation)throw new Error('Context operation canceled.');return result;
    }finally{if(checking===operation)checking=null;}
  }
  async function prepareNodeControlProof(input){
    if(!nodeControlProofFlow||busy())throw new Error('Node proof preparation unavailable.');
    preparing=true;const version=generation;
    try{const preview=await nodeControlProofFlow.prepare(input);if(version!==generation){nodeControlProofFlow.cancel(preview);throw new Error('Node proof preparation canceled.');}activeNodeProof=preview;return preview;}finally{preparing=false;}
  }
  async function executeNodeControlProof(preview,confirmation){
    if(activeNodeProof!==preview)throw new Error('Unknown Node proof preview.');const version=generation;
    try{const result=await nodeControlProofFlow.execute(preview,confirmation);if(version!==generation)throw new Error('Node proof export canceled.');return result;}finally{if(activeNodeProof===preview)activeNodeProof=null;}
  }
  async function readBuilderOperation(method,input){
    if(!builderFlow?.[method]||busy())throw new Error('Builder operation unavailable.');
    const operation=new AbortController(),version=generation;checking=operation;
    try{const result=await builderFlow[method](input,{signal:operation.signal});
      if(version!==generation||checking!==operation)throw new Error('Builder operation canceled.');return result;
    }finally{if(checking===operation)checking=null;}
  }
  async function readCollaborationOperation(method,input) {
    if (!assistanceFlow?.[method] || busy()) throw new Error('Collaboration operation unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await assistanceFlow[method](input, {signal:operation.signal});
      if (version !== generation || checking !== operation) throw new Error('Collaboration operation canceled.');
      return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function honorOperation(method, input) {
    if (!honorClient || busy()) throw new Error('Honor operation unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await honorClient[method](input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Honor operation canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function notificationOperation(method, input) {
    if (!notificationsClient || busy()) throw new Error('Notifications operation unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await notificationsClient[method](input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Notifications operation canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function projectDiscoveryOperation(method, input) {
    if (!projectDiscoveryClient || busy()) throw new Error('Project discovery operation unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await projectDiscoveryClient[method](input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Project discovery operation canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function queryRequesterHistory(input, method = 'requesterHistory') {
    if (!assistanceClient || busy()) throw new Error('Requester history unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await assistanceClient[method](input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('Requester history canceled.'); return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function listPublicationDrafts() {
    if (!publicationFlow || busy()) throw new Error('Draft list unavailable.');
    const version = generation;
    const items = await publicationFlow.list();
    if (version !== generation) throw new Error('Draft list canceled.');
    return items;
  }
  async function preparePublication(localCaseId, options) {
    if (!publicationFlow || busy()) throw new Error('Publication preparation unavailable.');
    preparing = true;
    const version = generation;
    try {
      const preview = await publicationFlow.prepare(localCaseId, options);
      if (version !== generation) { publicationFlow.cancel(preview); throw new Error('Publication preparation canceled.'); }
      activePublication = preview; return preview;
    } finally { preparing = false; }
  }
  async function executePublication(preview, confirmation) {
    if (!activePublication || activePublication !== preview) throw new Error('Unknown publication preview.');
    const version = generation;
    try {
      const receipt = await publicationFlow.execute(preview, confirmation);
      if (version !== generation) throw new Error('Publication canceled; check remote outcome.');
      return receipt;
    } finally { if (activePublication === preview) activePublication = null; }
  }
  async function reconcilePublication(localCaseId) {
    if (!publicationFlow || busy()) throw new Error('Publication reconciliation unavailable.');
    const operation = new AbortController(), version = generation;
    checking = operation;
    try {
      const result = await publicationFlow.reconcile(localCaseId, { signal: operation.signal });
      if (version !== generation) throw new Error('Publication reconciliation canceled.');
      return result;
    } finally { if (checking === operation) checking = null; }
  }
  function cancelPublication(preview) {
    if (activePublication !== preview) return false;
    cancel(); return true;
  }
  async function recordSearchFeedback(caseId, verdict) {
    const page = feedbackPage, version = generation;
    if (!saveSearchFeedback || busy() || !page?.items.has(caseId)) throw new Error('Current search result required.');
    const state = await sessions.status(endpoint);
    const assertCurrent=()=>version===generation&&feedbackPage===page&&(!page.lease||sessions.matchesAuthorization(page.lease));
    if (!assertCurrent() || state.state !== 'session-local' || !state.scopes?.includes(searchScope(page.type))
      ||state.subjectId!==page.subjectId||state.bindingId!==page.bindingId)
      throw new Error('Current search session required.');
    return saveSearchFeedback({ endpoint, subjectId: page.subjectId, query: page.query, item: page.items.get(caseId), verdict, assertCurrent });
  }
  async function readA2a(method, input = {}) {
    if (!a2aFlow || busy()) throw new Error('A2A read unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try {
      const result = await a2aFlow.read(method, input, { signal: operation.signal });
      if (version !== generation || checking !== operation) throw new Error('A2A read canceled.');
      return result;
    } finally { if (checking === operation) checking = null; }
  }
  async function prepareA2a(input) {
    if (!a2aFlow || busy()) throw new Error('A2A preparation unavailable.');
    preparing = true; const version = generation;
    try {
      const preview = await a2aFlow.prepare(input);
      if (version !== generation) { a2aFlow.cancel(preview); throw new Error('A2A preparation canceled.'); }
      activeA2a = preview; return preview;
    } finally { preparing = false; }
  }
  async function executeA2a(preview, confirmation) {
    if (!activeA2a || activeA2a !== preview) throw new Error('Unknown host A2A preview.');
    const version = generation;
    try {
      const result = await a2aFlow.execute(preview, confirmation);
      if (version !== generation) throw new Error('A2A local operation canceled; inspect remote outcome.');
      return result;
    } finally { if (activeA2a === preview) activeA2a = null; }
  }
  async function readIdentity(method,input={}) {
    if (!identityClient || busy()) throw new Error('Identity management unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try { const result = await identityClient.read(method,input,{signal:operation.signal});
      if(version!==generation||checking!==operation)throw new Error('Identity operation canceled.');return result;
    } finally { if(checking===operation)checking=null; }
  }
  async function prepareIdentity(action,input) {
    if (!identityClient || busy()) throw new Error('Identity management unavailable.');
    const operation = new AbortController(), version = generation; checking = operation;
    try { const preview = await identityClient.prepare(action,input,{signal:operation.signal});
      if(version!==generation||checking!==operation){identityClient.cancel(preview);throw new Error('Identity preparation canceled.');}
      activeIdentity=preview;return preview;
    } finally { if(checking===operation)checking=null; }
  }
  async function executeIdentity(preview,confirmation) {
    if(!activeIdentity||activeIdentity!==preview)throw new Error('Unknown identity preview.');
    const version=generation;
    try { const result=await identityClient.execute(preview,confirmation);
      if(version!==generation)throw new Error('Identity outcome requires refresh.');return result;
    } finally { if(activeIdentity===preview)activeIdentity=null; }
  }
  async function queryBindings(input={}){
    if(!bindingManagementClient||busy())throw new Error('Binding management unavailable.');
    const operation=new AbortController(),version=generation;checking=operation;
    try{const result=await bindingManagementClient.query(input,{signal:operation.signal});
      if(version!==generation||checking!==operation)throw new Error('Binding query canceled.');return result;
    }finally{if(checking===operation)checking=null;}
  }
  async function prepareBindingRevoke(bindingId){
    if(!bindingManagementClient||busy())throw new Error('Binding revocation unavailable.');
    const operation=new AbortController(),version=generation;checking=operation;
    try{const preview=await bindingManagementClient.prepareRevoke(bindingId,{signal:operation.signal});
      if(version!==generation||checking!==operation){bindingManagementClient.cancel(preview);throw new Error('Binding preparation canceled.');}
      activeBindingRevoke=preview;return preview;
    }finally{if(checking===operation)checking=null;}
  }
  async function executeBindingRevoke(preview,confirmation){
    if(!activeBindingRevoke||activeBindingRevoke!==preview)throw new Error('Unknown binding revocation preview.');
    const version=generation;
    try{const result=await bindingManagementClient.executeRevoke(preview,confirmation);
      if(version!==generation)throw new Error('Binding revocation outcome requires review.');return result;
    }finally{if(activeBindingRevoke===preview)activeBindingRevoke=null;}
  }
  return Object.freeze({ prepare, execute, cancel, disconnect, ...(statusClient ? { checkRemote } : {}),
    ...(projectDiscoveryClient ? { queryProjectDiscovery: input => projectDiscoveryOperation('query', input),
      projectDiscoveryPreferences: () => projectDiscoveryOperation('preferences', {}), saveProjectDiscoveryPreferences: input => projectDiscoveryOperation('save', input) } : {}),
    ...(identityClient?{readIdentity,prepareIdentity,executeIdentity}:{}),
    ...(bindingManagementClient?{queryBindings,prepareBindingRevoke,executeBindingRevoke}:{}),
    ...(dataExportClient ? { readDataExport } : {}), ...(saveExportToDirectory ? { saveDataExport } : {}),
    ...(auditClient ? { readAudit, prepareAudit, executeAudit } : {}),
    ...(deletionClient ? { readDeletion, prepareDeletion, executeDeletion } : {}),
    ...(deletionStatusClient ? { prepareDeletionStatus, executeDeletionStatus } : {}),
    ...(a2aFlow ? { readA2a, prepareA2a, executeA2a } : {}),
    ...(historyClient ? { queryHistory } : {}), ...(searchClient?{querySearch}:{}), ...(profileFlow?{prepareProfile,executeProfile}:{}), ...(caseReviewFlow?{prepareCaseReview,executeCaseReview}:{}), ...(caseClient ? { prepareCase, executeCase, getCase } : {}),
    ...(assistanceClient ? { prepareAssistance, executeAssistance, getAssistance, queryAssistance, queryRequesterHistory,
      ...(assistanceClient.requesterHistoryFacts ? { queryRequesterHistoryFacts: input => queryRequesterHistory(input, 'requesterHistoryFacts') } : {}),
      qualificationPolicies: () => queryRequesterHistory({}, 'qualificationPolicies'), evaluateQualification: input => queryRequesterHistory(input, 'evaluateQualification') } : {}),
    ...(assistanceFlow ? { prepareCollaboration, executeCollaboration } : {}),
    ...(assistanceFlow?.prepareRetry ? {
      listCollaborationOperations: () => readCollaborationOperation('list'),
      reconcileCollaboration: id => readCollaborationOperation('reconcile', id),
      forgetCollaborationOperation: id => readCollaborationOperation('forget', id),
      prepareCollaborationRetry: id => prepareCollaboration(id, true),
    } : {}),
    ...(contextClient ? { getContext: id => readContext('get', id), queryContext: id => readContext('query', id) } : {}),
    ...(contextFlow ? { prepareContext, executeContext } : {}),
    ...(contextFlow?.prepareRetry?{listContextOperations:()=>contextOperation('list'),reconcileContext:id=>contextOperation('reconcile',id),
      forgetContextOperation:id=>contextOperation('forget',id),prepareContextRetry:id=>prepareContext(id,true)}:{}),
    ...(moderationClient ? { getModeration: id => readModeration('get', id), queryModeration: input => readModeration('query', input), moderationConfig: () => readModeration('config', {}) } : {}),
    ...(moderationFlow ? { prepareModeration, executeModeration } : {}),
    ...(capsuleClient ? { getCapsule: input => readCapsule('get', input), queryCapsules: input => readCapsule('query', input), capsuleUses: input => readCapsule('uses', input) } : {}),
    ...(capsuleFlow ? { prepareCapsule, executeCapsule } : {}),
    ...(builderClient ? { getBuilder: input => readBuilder('get', input), queryBuilders: input => readBuilder('query', input),
      exportBuilderReport: input => readBuilder('exportReport', input),
      exportNodeControl:input=>readBuilder('exportNodeControl',input),
      ...(builderClient.verifyHub?{verifyHubDirectory:input=>readBuilder('verifyHub',input)}:{}),
      getBuilderManagement:input=>readBuilder('manage',input),queryOwnedBuilders:input=>readBuilder('owned',input),queryBuilderNotices:input=>readBuilder('notices',input) } : {}),
    ...(builderFlow ? { prepareBuilder, executeBuilder } : {}),
    ...(nodeControlProofFlow?{prepareNodeControlProof,executeNodeControlProof}:{}),
    ...(builderFlow?.prepareRetry?{listBuilderOperations:()=>readBuilderOperation('list'),reconcileBuilder:eventId=>readBuilderOperation('reconcile',eventId),
      forgetBuilderOperation:eventId=>readBuilderOperation('forget',eventId),prepareBuilderRetry:eventId=>prepareBuilder(eventId,true)}:{}),
    ...(honorClient ? { honorRules: () => honorOperation('rules', {}), honorRuleHistory:input=>honorOperation('ruleHistory',input), getHonor: input => honorOperation('query', input), getPublicHonor: input => honorOperation('publicQuery', input), honorRanking: input => honorOperation('ranking', input) } : {}),
    ...(notificationsClient ? { queryNotifications: input => notificationOperation('query', input),
      notificationPreferences: () => notificationOperation('preferences', {}), saveNotificationPreferences: input => notificationOperation('save', input),
      ...(notificationsClient.archive ? { archiveNotifications: input => notificationOperation('archive', input) } : {}),
      markNotificationRead: id => notificationOperation('markRead', id) } : {}),
    ...(publicationFlow ? { listPublicationDrafts, preparePublication, executePublication, reconcilePublication, cancelPublication } : {}),
    ...(saveSearchFeedback ? { recordSearchFeedback } : {}),
    status: () => sessions.status(endpoint) });
}
