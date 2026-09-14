import { ServiceError } from '../shared/service-error.mjs';
import { canReadProjection } from './consent-policy.mjs';

export async function liveBuilderProbe(db,{builderId,requestId,consents,endpoint,now,readBuilder,viewer}){
  const parent=(await(readBuilder?readBuilder(db,builderId):db.query('SELECT * FROM builders WHERE id=$1 FOR SHARE',[builderId]))).rows[0];
  if(!parent)throw new ServiceError('builder_probe_source_unavailable',404);
  const rows=(await db.query('SELECT * FROM builder_events WHERE builder_id=$1 ORDER BY revision',[builderId])).rows;
  const declaration=rows.findLast(row=>row.kind==='declare'),request=rows.find(row=>row.id===requestId&&row.kind==='probe-request');
  const unavailable=()=>{throw new ServiceError('builder_probe_source_unavailable',404);};
  if(!declaration||!request)unavailable();
  const declared=JSON.parse(declaration.payload_text).declaration,payload=JSON.parse(request.payload_text);
  const control=rows.findLast(row=>row.kind==='node-control'&&JSON.parse(row.payload_text).declarationId===declaration.id);
  if(declared.type!=='worker'||!declared.a2a||payload.declarationId!==declaration.id||payload.declarationHash!==declaration.payload_hash
    ||payload.nodeId!==declared.nodeId||request.subject_id!==declared.nodeId||!control||control.id!==payload.controlId)unavailable();
  const approval=JSON.parse(control.payload_text);
  if(approval.expiresAt<=now||rows.some(row=>row.kind==='node-control-revoke'&&JSON.parse(row.payload_text).controlId===control.id))unavailable();
  if(rows.findLast(row=>row.kind==='probe-request'&&JSON.parse(row.payload_text).declarationId===declaration.id)?.id!==requestId)unavailable();
  let delisted=false,securityIssue=false;
  for(const row of rows)if(row.kind==='maintenance'){
    const {action}=JSON.parse(row.payload_text);
    if(action==='delist')delisted=true;if(action==='relist')delisted=false;
    if(action==='security-issue')securityIssue=true;if(action==='resolve-security')securityIssue=false;
  }
  if(delisted||securityIssue)unavailable();
  for(const row of [declaration,control,request]){
    const grant=await consents.require(db,{id:row.consent_id,subjectId:row.subject_id,objectId:row.id,action:'builder.publish',recipient:endpoint,payloadJson:row.payload_text});
    if(viewer!==undefined&&!canReadProjection(grant,{viewerId:viewer,now}))unavailable();
  }
  return {request,target:payload.target};
}

export async function readBuilderProbe(service,db,actor,loaded,current,heartbeat){
  const base={...heartbeat,scope:current.payload.a2a?'selected-a2a-interface':'owner-heartbeat-only',endpointControlVerified:false};
  const request=loaded.rows.findLast(row=>row.kind==='probe-request'&&JSON.parse(row.payload_text).declarationId===current.row.id);
  if(!request)return base;
  try{await liveBuilderProbe(db,{builderId:loaded.parent.id,requestId:request.id,consents:service.consents,endpoint:service.access.endpoint,now:service.access.now(),viewer:actor?.subjectId??null});}
  catch(error){if(!(error instanceof ServiceError))throw error;return {...base,state:'unavailable',endpointProbed:false,endpointReachable:null,reason:'probe-source-unavailable'};}
  const job=(await db.query("SELECT id,state,attempts,available_at FROM jobs WHERE kind='builder-probe' AND deduplication_key=$1",['builder-probe:'+request.id])).rows[0];
  const result=(await db.query('SELECT observation FROM builder_probes WHERE request_id=$1 ORDER BY attempt DESC LIMIT 1',[request.id])).rows[0]?.observation;
  const state=result?result.validUntil<=service.access.now()?'expired':result.status:job?.state==='failed'?'unavailable':'pending';
  return {...base,state,requestId:request.id,endpoint:current.payload.a2a.endpoint,cardUrl:current.payload.a2a.cardUrl,
    ...(result?{observation:result,endpointProbed:result.stage==='rpc',endpointReachable:state==='expired'||result.status==='revoked'?null:result.endpointReachable}:{}),
    ...(job?{job:{state:job.state,attempts:job.attempts,nextAttemptAt:Math.floor(Date.parse(job.available_at)/1000)}}:{})};
}
