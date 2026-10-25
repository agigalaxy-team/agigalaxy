import {ServiceError} from '../../shared/service-error.mjs';
import {body} from './request.mjs';

const root='/v1/operations/recommendation';
const operationPath=/^operations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const reads=new Map([['overview','overview'],['history','history']]),writes=new Map([['policy','savePolicy'],['themes','saveTheme']]);
export async function dispatchOperationsRecommendation({operationsRecommendation,authorizeOperator,request,response,requestId,url,send}){
 if(url.pathname!==root&&!url.pathname.startsWith(root+'/'))return false;
 const part=url.pathname.slice(root.length+1),write=request.method==='POST',operation=operationPath.exec(part),method=write?writes.get(part):request.method==='GET'?(operation?'commandResult':reads.get(part)):null;
 if(!method)throw new ServiceError('not_found',404);
 const keys=part==='overview'?['days','query']:part==='history'?['after','limit']:[],input={};
 if(url.search.length>2048||write&&url.search)throw new ServiceError('invalid_recommendation_request',400);
 for(const[key,value]of url.searchParams){if(!keys.includes(key)||Object.hasOwn(input,key))throw new ServiceError('invalid_recommendation_request',400);input[key]=['days','limit'].includes(key)?Number(value):value;}
 if(!operationsRecommendation||typeof authorizeOperator!=='function')throw new ServiceError('discovery_recommendation_operations_not_connected',503);
 const actor=await authorizeOperator(request,{write,requestId,action:write?'recommendations.configure':'recommendations.read'});
 response?.setHeader('Cache-Control','no-store');response?.setHeader('Referrer-Policy','no-referrer');
 const value=operation?await operationsRecommendation.commandResult(actor,operation[1]):await operationsRecommendation[method](actor,write?await body(request,undefined,{maxBytes:16384}):input,write?{authorize:()=>authorizeOperator(request,{write:true,requestId})}:undefined);
 send(200,value);return true;
}
