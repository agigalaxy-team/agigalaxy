import {body,authenticate} from './request.mjs';
export async function dispatchIdentityGroups({identityGroups,access,request,requestId,url,send,consumeSearchPage}){
 if(!identityGroups||!url.pathname.startsWith('/v2/identity-groups'))return false;
 const id=/^\/v2\/identity-groups\/([0-9a-f-]{36})$/.exec(url.pathname),proposal=/^\/v2\/identity-groups\/operations\/([0-9a-f-]{36})$/.exec(url.pathname);
 const methods={'/v2/identity-groups/submit':'submit','/v2/identity-groups/query':'query','/v2/identity-groups/resolve':'resolve','/v2/identity-groups/receipt':'receipt','/v2/identity-groups/source':'source'};
 if(!(request.method==='GET'&&(id||proposal||url.pathname==='/v2/identity-groups/current')||request.method==='POST'&&methods[url.pathname]))return false;
 const publicRead=!!id||['query','resolve'].includes(methods[url.pathname]);
 const auth=await authenticate(request,access,'binding',publicRead),actor=auth?{...auth,httpRequestId:requestId}:null;
 if(request.method==='GET'){send(200,await(id?identityGroups.read(actor,id[1]):proposal?identityGroups.proposal(actor,proposal[1]):identityGroups.current(actor)));return true;}
 const method=methods[url.pathname],input=await body(request,method==='submit'?['payloadJson','proofJson','signature']:null);
 if(method==='query')consumeSearchPage(actor,input.after);send(200,await identityGroups[method](actor,input));return true;
}
