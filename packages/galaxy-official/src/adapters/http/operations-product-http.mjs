import {body} from './request.mjs';
import {productCommandResult} from '../../operations/product-command-receipts.mjs';
import {ServiceError} from '../../shared/service-error.mjs';

function page(url,{unread=false}={}){
  const result={};for(const [key,value]of url.searchParams){
    if(!['after','limit',...(unread?['unreadOnly']:[])].includes(key)||url.searchParams.getAll(key).length!==1)throw new ServiceError('invalid_operations_product_request');
    if(key==='unreadOnly'&&!['true','false'].includes(value))throw new ServiceError('invalid_operations_product_request');
    result[key]=key==='limit'?Number(value):key==='unreadOnly'?value==='true':value;
  }return result;
}

// Called alongside the existing operations/business and ordinary-account HTTP
// adapters. Only their verified management or account sessions supply actors.
export async function dispatchOperationsProduct({rules,notices,retention,operations,officialAccounts,request,response,requestId,url,send}){
  const accountList=url.pathname==='/v1/account/notifications/notices',accountRead=/^\/v1\/account\/notifications\/notices\/([0-9a-f-]{36})\/read$/.exec(url.pathname);
  if(accountList||accountRead){
    if(!notices||!officialAccounts)throw new ServiceError('operations_notices_unavailable',503);
    if(request.method!==(accountList?'GET':'POST'))throw new ServiceError('not_found',404);
    response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
    const actor=await officialAccounts.actionActor(request,{write:!!accountRead});
    if(accountList)send(200,await notices.accountQuery(actor,page(url,{unread:true})));
    else{if(url.search)throw new ServiceError('invalid_operations_product_request');await body(request,[]);send(200,await notices.accountMarkRead(actor,{noticeId:accountRead[1]}));}
    return true;
  }
  const root=/^\/v1\/operations\/(rules|notices|retention)(?:\/|$)/.test(url.pathname);
  if(!root)return false;
  if(!operations)throw new ServiceError('operations_unavailable',503);
  const portal=operations.portal??operations,write=request.method==='POST';
  if(!['GET','POST'].includes(request.method))throw new ServiceError('not_found',404);
  if(write&&url.search)throw new ServiceError('invalid_operations_product_request');
  const area=url.pathname.split('/')[3],noticeAction=url.pathname.split('/')[5];
  const required=area==='rules'?(write?'rules.write':'rules.read'):area==='retention'?(write?'retention.request':'retention.read')
    :write?(noticeAction==='save'?'notices.update':noticeAction==='publish'?'notices.publish':noticeAction==='withdraw'?'notices.withdraw':'notices.create'):'notices.read';
  const actor=await portal.authorizeOperator(request,{write,requestId,action:required});
  response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
  let result;
  const receipt=/^\/v1\/operations\/(notices|retention)\/operations\/([0-9a-f-]{36})$/.exec(url.pathname);
  const rule=/^\/v1\/operations\/rules\/(resource-budget|community-quota|forum-quota)(?:\/(history))?$/.exec(url.pathname);
  const notice=/^\/v1\/operations\/notices\/([0-9a-f-]{36})(?:\/(save|publish|withdraw))?$/.exec(url.pathname);
  const run=/^\/v1\/operations\/retention\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
  if(receipt){
    if(write||url.search)throw new ServiceError('not_found',404);
    const service=receipt[1]==='notices'?notices:retention;if(!service)throw new ServiceError('operations_unavailable',503);
    result=await productCommandResult({db:service.db,endpoint:service.endpoint,operator:actor,now:service.now,authorize:async()=>service.businessAdmin.authorizeAction(await portal.authorizeOperator(request,{write:false,requestId,action:required}),required)},receipt[2],receipt[1]);
  }else if(url.pathname==='/v1/operations/rules'&&!write){
    if(url.search)throw new ServiceError('invalid_operations_product_request');if(!rules)throw new ServiceError('operations_rules_unavailable',503);result=await rules.list(actor);
  }else if(rule){
    if(!rules)throw new ServiceError('operations_rules_unavailable',503);
    if(rule[2]){if(write)throw new ServiceError('not_found',404);result=await rules.history(actor,rule[1],page(url));}
    else if(write)result=await rules.save(actor,rule[1],await body(request,undefined,{maxBytes:32768}));
    else{if(url.search)throw new ServiceError('invalid_operations_product_request');result=await rules.get(actor,rule[1]);}
  }else if(url.pathname==='/v1/operations/notices'){
    if(!notices)throw new ServiceError('operations_notices_unavailable',503);
    result=write?await notices.create(actor,await body(request,undefined,{maxBytes:65536})):await notices.list(actor,page(url));
  }else if(notice){
    if(!notices)throw new ServiceError('operations_notices_unavailable',503);
    if(write&&notice[2])result=await notices[notice[2]](actor,notice[1],await body(request,undefined,{maxBytes:65536}));
    else if(!write&&!notice[2]){if(url.search)throw new ServiceError('invalid_operations_product_request');result=await notices.get(actor,notice[1]);}
    else throw new ServiceError('not_found',404);
  }else if(url.pathname==='/v1/operations/retention'&&!write){
    if(!retention)throw new ServiceError('operations_retention_unavailable',503);if(url.search)throw new ServiceError('invalid_operations_product_request');result=await retention.status(actor);
  }else if(url.pathname==='/v1/operations/retention/runs'){
    if(!retention)throw new ServiceError('operations_retention_unavailable',503);
    result=write?await retention.request(actor,await body(request,undefined,{maxBytes:4096})):await retention.list(actor,page(url));
  }else if(run&&!write){
    if(!retention)throw new ServiceError('operations_retention_unavailable',503);if(url.search)throw new ServiceError('invalid_operations_product_request');result=await retention.get(actor,run[1]);
  }else throw new ServiceError('not_found',404);
  send(200,result);return true;
}
