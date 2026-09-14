import {contributionPublicationSchema} from '../../galaxy-official/src/shared/contribution-sharing-v2-schema.mjs';
import {sha256Hex} from '../../galaxy-official/src/shared/web-primitives.mjs';
const instances=new WeakMap();
export function getContributionClient(runtime,subjectId){
  let map=instances.get(runtime);if(!map){map=new Map();instances.set(runtime,map);}if(map.has(subjectId))return map.get(subjectId);
  const endpoint=runtime.api.endpoint,key=`contribution-operations:${subjectId}`;let queue=Promise.resolve();
  const owner=()=>{if(runtime.api.endpoint!==endpoint||runtime.api.snapshot()?.subjectId!==subjectId)throw new Error('身份或连接已变化，请重新打开贡献页面。');};
  const serial=fn=>{const next=queue.then(fn,fn);queue=next.catch(()=>{});return next;};
  const load=async()=>{owner();const value=await runtime.getLocal(key);owner();return value??{pending:null,publications:[]};};
  const save=async data=>{owner();await runtime.putLocal(key,data);owner();};
  async function remember(record,result){const state=await load(),id=record.payload.publicationId??record.payload.id;
    const prior=state.publications.find(p=>p.publicationId===id);
    const value={...prior,publicationId:id,lastReceipt:result.state,sourceRefs:record.payload.sourceRefs??prior?.sourceRefs??[],expiresAt:record.payload.expiresAt??prior?.expiresAt??null};
    await save({pending:null,publications:[value,...state.publications.filter(p=>p.publicationId!==id)]});return result;
  }
  async function send(record,{reauthorize=false}={}){
    owner();
    if(!record.submission||reauthorize){
      const reconcile=!!record.prepared&&!reauthorize;
      if(!record.prepared||reauthorize){record.prepared=await runtime.api.prepareAuthorization(record.payloadJson,{action:'contribution.publish',objectId:record.payload.id,
        visibility:record.payload.kind==='publish'?'Public':'Private',confirmed:true});
        record.submission=null;await save({...await load(),pending:record});}
      record.submission=await runtime.api.submitAuthorization(record.prepared,{confirmed:true,reconcile});await save({...await load(),pending:record});
    }
    record.attempted=true;await save({...await load(),pending:record});owner();
    const receipt=await runtime.api.call('/v2/contributions/publish',record.submission);owner();
    if(receipt.operationId!==record.payload.id||receipt.publicationId!==(record.payload.publicationId??record.payload.id))throw new Error('回执不匹配，请查询原操作。');
    return remember(record,receipt);
  }
  const client={
    local:load,
    submit:(input,{confirmed=false}={})=>serial(async()=>{
      if(!confirmed)throw new Error('请先确认具体字段、用途和可见范围。');
      if((await load()).pending)throw new Error('请先查询或恢复上一次贡献操作。');
      const payload=contributionPublicationSchema.parse({...input,id:input.id??crypto.randomUUID()}),payloadJson=JSON.stringify(payload);
      const record={payload,payloadJson,payloadHash:await sha256Hex(payloadJson),attempted:false};
      await save({...await load(),pending:record});return send(record);
    }),
    reconcile:({retry=false,reauthorize=false,confirmed=false}={})=>serial(async()=>{
      const record=(await load()).pending;if(!record)return{state:'none'};
      const status=await runtime.api.call('/v2/contributions/status',{publicationId:record.payload.publicationId??record.payload.id});owner();
      const matches=record.payload.kind==='publish'?status.payloadHash===record.payloadHash:status.revokeOperationId===record.payload.id&&status.revokePayloadHash===record.payloadHash;
      if(matches)return remember(record,status);
      if(record.payload.kind==='publish'&&status.state!=='absent'||record.payload.kind==='revoke'&&status.revokeOperationId)throw new Error('服务端存在不同操作，请保留原记录并核对。');
      if(!retry)return{state:'unconfirmed',currentState:status.state};
      if(!confirmed)throw new Error('请确认只重试原操作。');
      return send(record,{reauthorize});
    }),
    refresh:async()=>{const state=await load(),items=[];for(const row of state.publications){owner();items.push({...row,...await runtime.api.call('/v2/contributions/status',{publicationId:row.publicationId})});}owner();return items;},
  };map.set(subjectId,client);return client;
}
