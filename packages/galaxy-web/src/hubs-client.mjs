import {hubEventSchema} from '../../galaxy-official/src/shared/hubs-v2-schema.mjs';
import {peeringEventSchema} from '../../galaxy-official/src/shared/hub-peering-v2-schema.mjs';
import {sha256Hex} from '../../galaxy-official/src/shared/web-primitives.mjs';
export function createHubsWebClient(runtime,{subjectId}={}){
  const endpoint=runtime.api.endpoint,key='hubs-v2:'+subjectId;
  /** @type {Promise<any>} */
  let queue=Promise.resolve();
  const owner=()=>{if(!subjectId||runtime.api.endpoint!==endpoint||runtime.api.snapshot()?.subjectId!==subjectId)throw new Error('身份或连接已变化，请重新打开。');};
  const serial=fn=>{const p=queue.then(fn,fn);queue=p.catch(()=>{});return p;};
  const load=async()=>{owner();const value=await runtime.getLocal(key);owner();return value??{pending:null};};
  const save=async value=>{owner();await runtime.putLocal(key,value);owner();};
  const base=p=>p.family==='peering'?'/v2/hubs/peering':'/v2/hubs';
  const check=async p=>{const r=await runtime.api.call(base(p)+'/receipt',{operationId:p.event.id,payloadHash:p.payloadHash});owner();return r;};
  async function send(p){
    if(!p.prepared){p.prepared=await runtime.api.prepareAuthorization(p.payloadJson,{action:'hub.publish',objectId:p.event.id,visibility:p.visibility,viewers:p.viewers,confirmed:true});await save({pending:p});}
    if(!p.submission){const reconcile=p.authorizationAttempted===true;p.authorizationAttempted=true;await save({pending:p});
      p.submission=await runtime.api.submitAuthorization(p.prepared,{confirmed:true,reconcile});await save({pending:p});}
    p.attempted=true;await save({pending:p});const r=await runtime.api.call(base(p)+'/events',p.submission);owner();
    if(r.operationId!==p.event.id||r.payloadHash!==p.payloadHash||r.hubId!==p.event.hubId)throw new Error('原操作与服务回执不匹配。');
    await save({pending:null,lastReceipt:r});return r;
  }
  return{local:load,query:(q={},authenticated=false)=>runtime.api.call('/v2/hubs/query',q,{authenticated}),
    read:(q,authenticated=false)=>runtime.api.call('/v2/hubs/read',q,{authenticated}),
    manage:q=>{owner();return runtime.api.call('/v2/hubs/manage',q);},
    peering:(method,q)=>{owner();if(!['read','query','list','preview','sources','connections','party'].includes(method))throw new Error('不支持的互联操作');return runtime.api.call('/v2/hubs/peering/'+method,q);},
    members:q=>{owner();return runtime.api.call('/v2/hubs/memberships',q);},intake:q=>{owner();return runtime.api.call('/v2/hubs/intake',q);},
    builder:async hubId=>{owner();return runtime.api.call('/v1/builders/manage/read',{builderId:hubId});},
    submit:(input,{visibility='Private',viewers=[],confirmed=false,family='hub'}={})=>serial(async()=>{
      owner();if(!confirmed)throw new Error('请先预览本次范围。');if((await load()).pending)throw new Error('请先核对上次回执。');
      if(!['hub','peering'].includes(family))throw new Error('未知操作类型');
      const event=(family==='peering'?peeringEventSchema:hubEventSchema).parse(input),payloadJson=JSON.stringify(event),p={event,payloadJson,payloadHash:await sha256Hex(payloadJson),visibility,viewers,family};
      if(new TextEncoder().encode(JSON.stringify({consentId:'00000000-0000-4000-8000-000000000000',payloadJson})).length>32000)throw new Error('本次文字超过接口大小限制，请缩短后重新预览。');
      await save({pending:p});return send(p);
    }),reconcile:({retry=false,confirmed=false}={})=>serial(async()=>{
      const p=(await load()).pending;if(!p)return{state:'none'};const r=await check(p);
      if(r.state==='recorded'){await save({pending:null,lastReceipt:r});return r;}
      if(!retry)return r;if(!confirmed)throw new Error('请确认仅重试原内容。');return send(p);
    }),discard:()=>serial(async()=>{const p=(await load()).pending;if(!p)return{state:'none'};const r=await check(p);await save({pending:null,lastReceipt:r});return r;})};
}
