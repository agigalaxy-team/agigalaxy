import {body} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {p14KeySchema,p14PageSchema,p14Parse} from '../../shared/p14-rules-schema.mjs';

function page(url){const q={};for(const [key,value]of url.searchParams){if(!['after','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_operations_rule_request',400);q[key]=key==='limit'?Number(value):value;}return p14Parse(p14PageSchema,q);}
// Root composes this before the legacy product adapter. Existing read URLs stay
// available; the old direct save URL cannot silently bypass draft/publication.
export async function dispatchP14Rules({p14Rules,authorizeOperator,request,response,requestId,url,send}){
 const root='/v1/operations/rules',overview=url.pathname===root+'/overview',detail=/^\/v1\/operations\/rules\/([a-z-]+)\/(detail|versions|draft|publish|restore|sample)$/.exec(url.pathname),
  operation=/^\/v1\/operations\/rules\/operations\/([0-9a-f-]{36})$/i.exec(url.pathname),legacy=request.method==='POST'&&/^\/v1\/operations\/rules\/(resource-budget|community-quota|forum-quota)$/.test(url.pathname);
 if(!overview&&!detail&&!operation&&!legacy)return false;
 const write=request.method==='POST';if(!['GET','POST'].includes(request.method))throw new ServiceError('not_found',404);
 if(!p14Rules||typeof authorizeOperator!=='function')throw new ServiceError('operations_rules_unavailable',503);
 if(detail)p14Parse(p14KeySchema,detail[1]);
 const command=detail&&['draft','publish','restore'].includes(detail[2]);
 if((overview||operation||detail&&['detail','versions'].includes(detail[2]))&&write||detail&&['draft','publish','restore','sample'].includes(detail[2])&&!write)throw new ServiceError('not_found',404);
 const actor=await authorizeOperator(request,{write,requestId,action:command||legacy?'rules.write':'rules.read'});
 response?.setHeader('Cache-Control','no-store');response?.setHeader('Referrer-Policy','no-referrer');
 if(legacy)throw new ServiceError('operations_rule_explicit_publication_required',409);
 let result;
 if(overview){if(url.search)throw new ServiceError('invalid_operations_rule_request',400);result=await p14Rules.overview(actor);}
 else if(operation){if(url.search)throw new ServiceError('invalid_operations_rule_request',400);result=await p14Rules.operation(actor,operation[1]);}
 else if(detail[2]==='versions')result=await p14Rules.versions(actor,detail[1],page(url));
 else{if(url.search)throw new ServiceError('invalid_operations_rule_request',400);
  if(detail[2]==='detail')result=await p14Rules.get(actor,detail[1]);
  else{const input=await body(request,undefined,{maxBytes:262144});
   if(detail[2]==='sample')result=await p14Rules.sample(actor,detail[1],input);
   else result=await p14Rules[detail[2]==='draft'?'saveDraft':detail[2]](actor,detail[1],input,{authorize:()=>authorizeOperator(request,{write:true,requestId})});
  }
 }
 send(200,result);return true;
}
