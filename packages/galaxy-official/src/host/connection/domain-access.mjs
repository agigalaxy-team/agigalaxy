// Bounded domain operations keep their original client, current authority and cancellation checks.
// The shared accessors remain live after every await; no session or operation is snapshotted.
export function createHostDomainAccess({caseClient,busy,assistanceClient,contextClient,moderationClient,capsuleClient,dataExportClient,saveExportToDirectory,deletionClient,auditClient,builderClient,honorClient,notificationsClient,projectDiscoveryClient,a2aFlow,identityClient,bindingManagementClient,controllerState}){
  async function getCase(caseId) {
    if (!caseClient || busy()) throw new Error('Case read unavailable.');
    const operation = new AbortController(), version = controllerState.generation;
    controllerState.checking = operation;
    try {
      const result = await caseClient.get(caseId, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Case read canceled.');
      return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function getAssistance(assistanceId) {
    if (!assistanceClient || busy()) throw new Error('Assistance read unavailable.');
    const operation = new AbortController(), version = controllerState.generation;
    controllerState.checking = operation;
    try {
      const result = await assistanceClient.get(assistanceId, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Assistance read canceled.');
      return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function queryAssistance(input) {
    if (!assistanceClient || busy()) throw new Error('Assistance query unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await assistanceClient.query(input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Assistance query canceled.');
      return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function readContext(method, id) {
    if (!contextClient || busy()) throw new Error('Context read unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await contextClient[method](id, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Context read canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function readModeration(method, id) {
    if (!moderationClient || busy()) throw new Error('Moderation read unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await moderationClient[method](id, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Moderation read canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function readCapsule(method, id) {
    if (!capsuleClient || busy()) throw new Error('Capsule read unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await capsuleClient[method](id, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Capsule read canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function readDataExport(method, input = {}) {
    if (!dataExportClient || busy() || !['specification', 'create', 'page', 'binary', 'revoke'].includes(method)) throw new Error('Data export operation unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await dataExportClient[method](input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Data export canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function saveDataExport(id, directory) {
    if (!saveExportToDirectory || busy()) throw new Error('Local export unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await saveExportToDirectory(id, directory, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Export canceled; inspect the selected local directory.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function readDeletion(method, input = {}) {
    if (!deletionClient || busy() || !['config','query','read'].includes(method)) throw new Error('Deletion operation unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await deletionClient[method](input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Deletion read canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function readAudit(method, input = {}) {
    if (!auditClient || busy()) throw new Error('Audit operation unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await auditClient[method](input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Audit read canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function readBuilder(method, id) {
    if (!builderClient || busy()) throw new Error('Builder read unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await builderClient[method](id, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Builder read canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function honorOperation(method, input) {
    if (!honorClient || busy()) throw new Error('Honor operation unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await honorClient[method](input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Honor operation canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function notificationOperation(method, input) {
    if (!notificationsClient || busy()) throw new Error('Notifications operation unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await notificationsClient[method](input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Notifications operation canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function projectDiscoveryOperation(method, input) {
    if (!projectDiscoveryClient || busy()) throw new Error('Project discovery operation unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await projectDiscoveryClient[method](input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Project discovery operation canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function queryRequesterHistory(input, method = 'requesterHistory') {
    if (!assistanceClient || busy()) throw new Error('Requester history unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await assistanceClient[method](input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Requester history canceled.'); return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function readA2a(method, input = {}) {
    if (!a2aFlow || busy()) throw new Error('A2A read unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await a2aFlow.read(method, input, { signal: operation.signal });
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('A2A read canceled.');
      return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function readIdentity(method,input={}) {
    if (!identityClient || busy()) throw new Error('Identity management unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try { const result = await identityClient.read(method,input,{signal:operation.signal});
      if(version!==controllerState.generation||controllerState.checking!==operation)throw new Error('Identity operation canceled.');return result;
    } finally { if(controllerState.checking===operation)controllerState.checking=null; }
  }
  async function queryBindings(input={}){
    if(!bindingManagementClient||busy())throw new Error('Binding management unavailable.');
    const operation=new AbortController(),version=controllerState.generation;controllerState.checking=operation;
    try{const result=await bindingManagementClient.query(input,{signal:operation.signal});
      if(version!==controllerState.generation||controllerState.checking!==operation)throw new Error('Binding query canceled.');return result;
    }finally{if(controllerState.checking===operation)controllerState.checking=null;}
  }
  return Object.freeze({getCase,getAssistance,queryAssistance,readContext,readModeration,readCapsule,readDataExport,saveDataExport,readDeletion,readAudit,readBuilder,honorOperation,notificationOperation,projectDiscoveryOperation,queryRequesterHistory,readA2a,readIdentity,queryBindings});
}
