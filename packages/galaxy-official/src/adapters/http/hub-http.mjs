import {body,authenticate} from './request.mjs';
import {peeringWriteSchema} from '../../shared/hub-peering-v2-schema.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
const methods={status:'specification',events:'submit',read:'get',manage:'manage',query:'query',memberships:'members',intake:'intake',receipt:'receipt'};
const peerMethods={events:'submit',read:'read',query:'query',list:'list',preview:'preview',receipt:'receipt',sources:'sources',connections:'connections',party:'party'};
export async function dispatchHubs({hubs,peering,access,request,requestId,url,send,consumeSearchPage}){
  if(request.method!=='POST'||!hubs)return false;
  if(url.pathname==='/v2/hubs/peering/exchange'){
    // The scoped remote JWS is verified by the selected agreement, never
    // promoted to a local binding or an ambient Galaxy credential.
    await send(200,await peering.exchange(await body(request,['signed'])));return true;
  }
  const m=/^\/v2\/hubs\/(peering\/)?([a-z]+)$/.exec(url.pathname);if(!m)return false;
  const service=m[1]?peering:hubs,method=(m[1]?peerMethods:methods)[m[2]];if(!service||!method)return false;
  const optional=!m[1]&&['status','read','query'].includes(m[2]),authenticated=await authenticate(request,access,'builders',optional);
  const actor=authenticated?{...authenticated,httpRequestId:requestId}:null,input=await body(request,method==='submit'?['consentId','payloadJson']:undefined);
  if(method==='submit'&&!peeringWriteSchema.safeParse(input).success)throw new ServiceError('invalid_hub_write',400);
  if(['query','list','members','intake'].includes(method))consumeSearchPage?.(actor,input.after??null);
  await send(200,await (method==='specification'?service.specification():service[method](actor,input)));return true;
}
