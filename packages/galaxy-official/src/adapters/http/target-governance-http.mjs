import { body, authenticate } from './request.mjs';
export async function dispatchTargetGovernance({targetGovernance,access,request,requestId,url,send,consumeSearchPage}) {
 if(!targetGovernance)return false;
 const id=/^\/v2\/target-governance\/([0-9a-f-]{36})$/.exec(url.pathname),get=request.method==='GET';
 const methods={'/v2/target-governance/target':'targetInfo','/v2/target-governance/reports':'report','/v2/target-governance/events':'event','/v2/target-governance/query':'query','/v2/target-governance/receipt':'receipt'};
 if(!(get&&(id||url.pathname==='/v2/target-governance/config')||request.method==='POST'&&methods[url.pathname]))return false;
 const actor={...await authenticate(request,access,'moderation'),httpRequestId:requestId};
 if(get){send(200,await(id?targetGovernance.read(actor,id[1]):targetGovernance.config(actor)));return true;}
 const method=methods[url.pathname],input=await body(request,['report','event'].includes(method)?['consentId','payloadJson']:null);
 if(method==='query')consumeSearchPage(actor,input.after);
 send(200,await targetGovernance[method](actor,input));return true;
}
