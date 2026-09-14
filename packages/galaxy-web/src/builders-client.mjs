import {builderEventSchema} from '../../galaxy-official/src/shared/builders-schema.mjs';
import {builderExtensionEventSchema} from '../../galaxy-official/src/shared/builder-support-v2-schema.mjs';
import {sha256Hex} from '../../galaxy-official/src/shared/web-primitives.mjs';
export function createBuildersWebClient(runtime,{subjectId}={}){
  const endpoint=runtime.api.endpoint,key='builder-web-v2:'+subjectId;
  /** @type {Promise<any>} */
  let queue=Promise.resolve();
  const owner=()=>{if(!subjectId||runtime.api.endpoint!==endpoint||runtime.api.snapshot()?.subjectId!==subjectId)throw new Error('身份或连接已变化，请重新连接。');};
  const serial=fn=>{const next=queue.then(fn,fn);queue=next.catch(()=>{});return next;};
  const load=async()=>{owner();const value=await runtime.getLocal(key);owner();return value??{pending:null};};
  const save=async data=>{owner();await runtime.putLocal(key,data);owner();};
  async function send(record){
    if(!record.prepared){
      record.prepared=await runtime.api.prepareAuthorization(record.payloadJson,{action:'builder.publish',objectId:record.event.id,
        visibility:record.visibility,viewers:record.viewers,confirmed:true});await save({pending:record});
    }
    if(!record.submission){const reconcile=record.authorizationAttempted===true;record.authorizationAttempted=true;await save({pending:record});
      record.submission=await runtime.api.submitAuthorization(record.prepared,{confirmed:true,reconcile});
      await save({pending:record});}
    record.attempted=true;await save({pending:record});
    const receipt=await runtime.api.call(record.path,record.submission);owner();
    if(receipt.builderId!==record.event.builderId||receipt.eventId!==record.event.id)throw new Error('回执与原操作不匹配。');
    await save({pending:null,lastReceipt:receipt});return receipt;
  }
  return {
    local:load,
    query:(input={},authenticated=false)=>runtime.api.call('/v1/builders/query',input,{authenticated}),
    read:async(builderId,authenticated=false)=>({entry:await runtime.api.call('/v1/builders/read',{builderId},{authenticated}),
      extensions:await runtime.api.call('/v2/builders/support/read',{builderId},{authenticated})}),
    owned:input=>{owner();return runtime.api.call('/v1/builders/owned/query',input??{});},
    manage:builderId=>{owner();return runtime.api.call('/v1/builders/manage/read',{builderId});},
    exportPack:(builderId,manifestId,authenticated=false)=>runtime.api.call('/v2/builders/pack/export',{builderId,manifestId},{authenticated}),
    submit:(input,{visibility='Private',viewers=[],confirmed=false}={})=>serial(async()=>{
      owner();if(!confirmed)throw new Error('请先核对内容和可见范围。');
      if((await load()).pending)throw new Error('先核对上一次操作回执。');
      const extension=['support-profile','pack-manifest','scope-report'].includes(input.kind),event=(extension?builderExtensionEventSchema:builderEventSchema).parse(input);
      const payloadJson=JSON.stringify(event),record={event,payloadJson,payloadHash:await sha256Hex(payloadJson),
        path:extension?'/v2/builders/support/events':'/v1/builders/events',visibility,viewers};
      await save({pending:record});return send(record);
    }),
    reconcile:({retry=false,confirmed=false}={})=>serial(async()=>{
      const record=(await load()).pending;if(!record)return {state:'none'};
      const receipt=await runtime.api.call('/v1/builders/events/receipt',{builderId:record.event.builderId,eventId:record.event.id,payloadHash:record.payloadHash});owner();
      if(receipt.state==='acknowledged'){await save({pending:null,lastReceipt:receipt});return receipt;}
      if(receipt.state==='conflict')throw new Error('原操作标识对应不同内容，不能覆盖。');
      if(!retry)return receipt;if(!confirmed)throw new Error('请确认仅重试原操作。');
      return send(record);
    }),
    discard:()=>serial(async()=>{
      const record=(await load()).pending;if(!record)return {state:'none'};
      const receipt=await runtime.api.call('/v1/builders/events/receipt',{builderId:record.event.builderId,eventId:record.event.id,payloadHash:record.payloadHash});owner();
      if(receipt.state==='conflict')throw new Error('服务端原操作有冲突，请先核对。');
      await save({pending:null,lastReceipt:receipt});return receipt;
    })
  };
}
