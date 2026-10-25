export function markTaskRead(value, scope, seen = new WeakSet(), inheritedTaskId = null, projectionRead = null, purpose = null) {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value); let found = false;
    const taskId=value.taskId??value.record?.taskId??(value.object?.type==='task'?value.object.id:value.type==='task'||value.recordKind==='task'?value.ref?.id??value.id:inheritedTaskId);
    const source=value.source??value.ref;
    if(purpose&&source){
      if(source.kind&&source.id&&source.payloadHash)projectionRead={source:{kind:source.kind,id:source.id,eventVersion:source.eventVersion,payloadHash:source.payloadHash},purpose};
      else if(source.publicationId&&source.sourceKey)projectionRead={publicationId:source.publicationId,sourceKey:source.sourceKey,purpose};
    }
    if (value.taskId && value.request || value.textView) {
      Object.defineProperty(value, '_webTaskScope', { value: scope, enumerable: false, configurable: true });
      if(taskId)Object.defineProperty(value,'_webTaskId',{value:taskId,enumerable:false,configurable:true}); found = true;
      if(projectionRead)Object.defineProperty(value,'_webTaskRead',{value:projectionRead,enumerable:false,configurable:true});
    }
    for (const nested of Object.values(value)) if (markTaskRead(nested, scope, seen, taskId, projectionRead, purpose)) found = true;
    return found;
  }
