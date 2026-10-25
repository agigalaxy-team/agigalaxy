// Local operation journals and exact-receipt recovery stay with the original configured flows.
// The shared accessors remain live after every await; no session or operation is snapshotted.
export function createHostRecovery({contextFlow,busy,builderFlow,assistanceFlow,publicationFlow,controllerState}){
  async function contextOperation(method,id){
    if(!contextFlow?.[method]||busy())throw new Error('Context operation unavailable.');
    const operation=new AbortController(),version=controllerState.generation;controllerState.checking=operation;
    try{const result=await contextFlow[method](id,{signal:operation.signal});
      if(version!==controllerState.generation||controllerState.checking!==operation)throw new Error('Context operation canceled.');return result;
    }finally{if(controllerState.checking===operation)controllerState.checking=null;}
  }
  async function readBuilderOperation(method,input){
    if(!builderFlow?.[method]||busy())throw new Error('Builder operation unavailable.');
    const operation=new AbortController(),version=controllerState.generation;controllerState.checking=operation;
    try{const result=await builderFlow[method](input,{signal:operation.signal});
      if(version!==controllerState.generation||controllerState.checking!==operation)throw new Error('Builder operation canceled.');return result;
    }finally{if(controllerState.checking===operation)controllerState.checking=null;}
  }
  async function readCollaborationOperation(method,input) {
    if (!assistanceFlow?.[method] || busy()) throw new Error('Collaboration operation unavailable.');
    const operation = new AbortController(), version = controllerState.generation; controllerState.checking = operation;
    try {
      const result = await assistanceFlow[method](input, {signal:operation.signal});
      if (version !== controllerState.generation || controllerState.checking !== operation) throw new Error('Collaboration operation canceled.');
      return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  async function listPublicationDrafts() {
    if (!publicationFlow || busy()) throw new Error('Draft list unavailable.');
    const version = controllerState.generation;
    const items = await publicationFlow.list();
    if (version !== controllerState.generation) throw new Error('Draft list canceled.');
    return items;
  }
  async function reconcilePublication(localCaseId) {
    if (!publicationFlow || busy()) throw new Error('Publication reconciliation unavailable.');
    const operation = new AbortController(), version = controllerState.generation;
    controllerState.checking = operation;
    try {
      const result = await publicationFlow.reconcile(localCaseId, { signal: operation.signal });
      if (version !== controllerState.generation) throw new Error('Publication reconciliation canceled.');
      return result;
    } finally { if (controllerState.checking === operation) controllerState.checking = null; }
  }
  return Object.freeze({contextOperation,readBuilderOperation,readCollaborationOperation,listPublicationDrafts,reconcilePublication});
}
