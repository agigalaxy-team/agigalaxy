import {ciRequestV2Schema,ciSourceMetadata} from '../../galaxy-official/src/shared/ci-observation-v2-schema.mjs';
import {githubReference} from '../../galaxy-official/src/shared/github-evidence-schema.mjs';
import {sha256Hex} from '../../galaxy-official/src/shared/web-primitives.mjs';
const clients=new WeakMap();
export function ciSourceFromEvidence(view){
  const record=view?.record;if(view?.referenceStatus!=='current'||record?.kind!=='evidence'||record.evidenceType!=='ci-result'||record.source.originSystem!=='github-actions')return null;
  const match=/^github-actions:([^/:]+)\/([^/:]+):run:([0-9]+):attempt:([0-9]+)$/.exec(record.source.externalStableId);if(!match)return null;
  const parsed=githubReference.safeParse({provider:'github-actions',owner:match[1],repository:match[2],runId:Number(match[3]),attempt:Number(match[4]),commit:record.source.contentVersion});
  if(!parsed.success||!Object.entries(ciSourceMetadata(parsed.data)).every(([k,v])=>record.source[k]===v))return null;return parsed.data;
}
export function getCiClient(runtime,subjectId){let owners=clients.get(runtime);if(!owners){owners=new Map();clients.set(runtime,owners);}if(owners.has(subjectId))return owners.get(subjectId);
  const endpoint=runtime.api.endpoint,key=`ci-operations:${subjectId}`;let queue=Promise.resolve();
  const owner=()=>{if(runtime.api.endpoint!==endpoint||runtime.api.snapshot()?.subjectId!==subjectId)throw new Error('身份或连接已变化，请重新打开 CI 记录。');};
  const serial=fn=>{const p=queue.then(fn,fn);queue=p.catch(()=>{});return p;};
  const local=async()=>{owner();const s=await runtime.getLocal(key);owner();return s??{pending:null,requests:[],proofs:[]};};
  const save=async s=>{owner();await runtime.putLocal(key,s);owner();};
  async function remember(record){const s=await local(),field=record.type==='request'?'requests':'proofs';
    const item=record.type==='request'?{id:record.payload.id,caseId:record.payload.caseId,evidenceRef:record.payload.evidenceRef,resultRef:record.payload.resultRef}
      :{id:record.payload.id,requestId:record.payload.bindingId,visibility:record.visibility};
    await save({...s,pending:null,[field]:[item,...s[field].filter(p=>p.id!==item.id)]});return{id:item.id,state:'recorded'};}
  async function send(record,{reauthorize=false}={}){
    if(!record.submission||reauthorize){
      if(!record.prepared||reauthorize){record.prepared=await runtime.api.prepareAuthorization(record.payloadJson,{action:record.type==='request'?'ci.observe':'proof.publish',
        objectId:record.payload.id,visibility:record.visibility,confirmed:true});record.submission=null;record.authorizationAttempted=false;await save({...await local(),pending:record});}
      const reconcile=record.authorizationAttempted===true;record.authorizationAttempted=true;await save({...await local(),pending:record});
      record.submission=await runtime.api.submitAuthorization(record.prepared,{confirmed:true,reconcile});await save({...await local(),pending:record});
    }
    owner();const result=await runtime.api.call(record.type==='request'?'/v2/ci/requests':'/v2/ci/proofs/publish',record.submission);owner();
    if((result.requestId??result.proofId)!==record.payload.id)throw new Error('回执不匹配，请查询原操作。');await remember(record);return result;
  }
  const api={local,
    submit:(type,payload,{confirmed=false,visibility='Private'}={})=>serial(async()=>{
      if(!confirmed||!['request','proof'].includes(type)||!['Private','Public'].includes(visibility))throw new Error('请确认这次观测或证明披露。');
      if((await local()).pending)throw new Error('请先恢复上一次 CI 操作。');
      if(type==='request'){payload=ciRequestV2Schema.parse(payload);visibility='Private';}
      const payloadJson=JSON.stringify(payload),record={type,payload,payloadJson,payloadHash:await sha256Hex(payloadJson),visibility};
      await save({...await local(),pending:record});return send(record);
    }),
    reconcile:({retry=false,reauthorize=false,confirmed=false}={})=>serial(async()=>{const record=(await local()).pending;if(!record)return{state:'none'};
      const receipt=await runtime.api.call('/v2/ci/receipts',{type:record.type,id:record.payload.id});owner();
      if(receipt.state==='recorded'){if(receipt.payloadHash!==record.payloadHash)throw new Error('发现不同内容的同号操作，请保留记录核对。');return remember(record);}
      if(!retry)return{state:'unconfirmed'};if(!confirmed)throw new Error('请确认重试原操作。');return send(record,{reauthorize});}),
  };owners.set(subjectId,api);return api;
}
