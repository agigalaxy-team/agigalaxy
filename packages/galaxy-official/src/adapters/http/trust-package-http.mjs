import {body,authenticate} from './request.mjs';
const paths={'/v2/trust-package/permissions/preview':'preview','/v2/trust-package/permissions/submit':'submit',
 '/v2/trust-package/permissions/revoke-preview':'revokePreview','/v2/trust-package/permissions/receipt':'receipt',
 '/v2/trust-package/permissions/status':'status','/v2/trust-package/permissions/query':'query','/v2/trust-package/sources':'sources'};
export async function dispatchTrustPackages({trustPackages,access,request,requestId,url,send,consumeSearchPage}){
 const method=paths[url.pathname];if(!trustPackages||request.method!=='POST'||!method)return false;
 const actor={...await authenticate(request,access,'consent'),httpRequestId:requestId},input=await body(request);
 if(method==='query')consumeSearchPage?.(actor,input.after??null);
 await send(200,await trustPackages[method](actor,input));return true;
}
