import {body,authenticate} from './request.mjs';
const paths=Object.freeze({register:'register',takeover:'takeover',stop:'stop',query:'query',read:'get',receipt:'receipt'});
export async function dispatchWatchControls({watchControls,access,request,requestId,url,send,consumeSearchPage=()=>{}}){
 const matched=/^\/v2\/watch-controls\/(register|takeover|stop|query|read|receipt)$/.exec(url.pathname);
 if(!watchControls||request.method!=='POST'||!matched)return false;
 const method=paths[matched[1]],actor={...await authenticate(request,access,'binding'),httpRequestId:requestId},input=await body(request,null);
 if(method==='query')consumeSearchPage(actor,input.after);
 send(200,await watchControls[method](actor,input));return true;
}
