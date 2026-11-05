// V2 content is embedded in its message; only tool calls have source IDs.
// The message-content key is a local observation key, not a host part ID.
export function v2WorkObservations(raw, info, {asTime,content,short}) {
 const out=[];const text=raw.type==='user'?raw.text:(raw.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
 if(typeof text==='string'&&text&&(info.role==='user'||info.time?.completed))out.push({sourceId:'message-content:'+info.id,kind:'message',occurredAt:asTime(info.time?.completed??info.time?.created),source:{kind:info.role==='user'?'user-statement':'model-report',messageId:info.id},content:content(text),details:{revisionBasis:'local-observation',sourceVersion:'unknown',role:info.role,completed:true}});
 for(const [index,file] of (raw.files??[]).entries())out.push({sourceId:'message-file:'+info.id+':'+index,kind:'artifact',occurredAt:asTime(info.time?.created),source:{kind:'external-material',messageId:info.id},details:{revisionBasis:'local-observation',sourceVersion:'unknown',filename:short(file.name,256),mime:short(file.mime,120),hostReferenceOnly:true,attachmentRead:false}});
 for(const tool of raw.content??[]){if(tool.type!=='tool'||typeof tool.id!=='string'||!tool.state)continue;const state=tool.state,status=state.status==='streaming'?'running':state.status;if(!['running','completed','error'].includes(status))continue;
  const output=status==='completed'?(state.content??[]).filter(item=>item.type==='text').map(item=>item.text).join('\n'):status==='error'?(state.error?.message??''):'';
  out.push({sourceId:'tool:'+info.id+':'+tool.id,kind:'tool',occurredAt:asTime(tool.time?.completed??tool.time?.ran??tool.time?.created??info.time?.created),source:{kind:'tool-report',messageId:info.id},content:content(output),details:{revisionBasis:'local-observation',sourceVersion:'unknown',tool:short(tool.name,160),status,callId:short(tool.id,256),startedAt:asTime(tool.time?.ran)||null,endedAt:asTime(tool.time?.completed)||null,workOutcome:'unknown'}});
 }
 return out;
}
