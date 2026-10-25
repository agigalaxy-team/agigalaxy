import {ServiceError} from '../../shared/service-error.mjs';
import {body} from './request.mjs';
const root='/v1/operations/search-quality',uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const reads=new Map([['overview','overview'],['history','history']]),writes=new Map([['draft',{method:'saveDraft',action:'search-quality.configure'}],['apply',{method:'apply',action:'search-quality.publish'}],['restore',{method:'restore',action:'search-quality.restore'}]]);
export async function dispatchOperationsSearchQuality({operationsSearchQuality,authorizeOperator,request,response,requestId,url,send}){
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const part=url.pathname.slice(root.length+1),operation=part.startsWith('operations/')&&uuid.test(part.slice(11))?part.slice(11):null,write=request.method==='POST',target=write?writes.get(part):request.method==='GET'?reads.has(part)?{method:reads.get(part),action:'search-quality.read'}:operation?{method:'operation',action:'search-quality.read'}:null:null;
 if(!target)throw new ServiceError('not_found',404);
 const keys=part==='overview'?['days','query','issue','after','limit']:part==='history'?['after','limit']:[],input={};
 if(url.search.length>4096||write&&url.search)throw new ServiceError('invalid_search_quality_request',400);
 for(const[key,value]of url.searchParams){if(!keys.includes(key)||Object.hasOwn(input,key))throw new ServiceError('invalid_search_quality_request',400);input[key]=['days','limit'].includes(key)?Number(value):value;}
 if(!operationsSearchQuality||typeof authorizeOperator!=='function')throw new ServiceError('discovery_search_quality_not_connected',503);
 const actor=await authorizeOperator(request,{write,requestId,action:target.action});response?.setHeader('Cache-Control','no-store');response?.setHeader('Referrer-Policy','no-referrer');
 const value=await operationsSearchQuality[target.method](actor,write?await body(request,undefined,{maxBytes:32768}):operation??input,write?{authorize:()=>authorizeOperator(request,{write:true,requestId})}:undefined);send(200,value);return true;
}

