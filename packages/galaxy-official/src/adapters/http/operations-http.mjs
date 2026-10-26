import {ServiceError} from '../../shared/service-error.mjs';
import {body} from './request.mjs';
import {operationsQueues} from "../../operations/jobs/service.mjs";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const page = url => {
  if ([...url.searchParams].some(([key])=>!['queue','after','limit'].includes(key)||url.searchParams.getAll(key).length!==1))
    throw new ServiceError('invalid_operations_query');
  const queue=url.searchParams.get('queue')??operationsQueues[0];
  const after=url.searchParams.get('after'), limit=Number(url.searchParams.get('limit')??50);
  if (!operationsQueues.includes(queue)||after&&!uuid.test(after)||!Number.isInteger(limit)||limit<1||limit>100)
    throw new ServiceError('invalid_operations_query');
  return {queue,after:after??undefined,limit};
};

export async function dispatchOperations({operations,businessAdmin,operationsJobs,searchIndex,contentPublications,request,response,requestId,url,send}) {
  if (!/^\/v1\/operations(?:\/|$)/.test(url.pathname)) return false;
  if (!operations) throw new ServiceError('operations_unavailable',503);
  response.setHeader('Cache-Control','no-store');
  response.setHeader('Referrer-Policy','no-referrer');
  const portal=operations.portal??operations;
  const auditCommand=async(actor,action,db)=>{
    if(!businessAdmin)throw new ServiceError('business_admin_unavailable',503);
    return businessAdmin.authorizeAction(actor,action,db?{db}:{});
  };
  if (request.method==='GET'&&url.pathname==='/v1/operations/login') {
    await portal.login(request,response,url); return true;
  }
  if (request.method==='GET'&&url.pathname==='/v1/operations/callback') {
    await portal.callback(request,response,url); return true;
  }
  if (request.method==='GET'&&url.pathname==='/v1/operations/session') {
    if (url.search) throw new ServiceError('invalid_operations_query');
    send(200,await portal.session(request)); return true;
  }
  if (request.method==='POST'&&url.pathname==='/v1/operations/logout') {
    if (url.search) throw new ServiceError('invalid_operations_query');
    await body(request,[]); send(200,await portal.logout(request,response)); return true;
  }
  if (url.pathname==='/v1/operations/content/publications'&&['GET','POST'].includes(request.method)) {
    const actor=await portal.authorizeOperator(request,{write:request.method==='POST',requestId,action:request.method==='POST'?'cms.publish':'cms.read'});
    if(!contentPublications)throw new ServiceError('site_publication_unavailable',503);
    if(request.method==='POST'){
      if(url.search)throw new ServiceError('invalid_operations_query');
      const input=await body(request,['operationId','snapshot'],{maxBytes:1100000});
      send(200,await contentPublications.request(actor,input));return true;
    }
    if([...url.searchParams.keys()].some(key=>!['after','limit'].includes(key)||url.searchParams.getAll(key).length!==1))throw new ServiceError('invalid_operations_query');
    send(200,await contentPublications.list(actor,{after:url.searchParams.get('after')??undefined,limit:Number(url.searchParams.get('limit')??20)}));return true;
  }
  const publication=/^\/v1\/operations\/content\/publications\/([0-9a-f-]{36})$/.exec(url.pathname);
  if(request.method==='GET'&&publication){
    const actor=await portal.authorizeOperator(request,{write:false,requestId,action:'cms.read'});
    if(!contentPublications)throw new ServiceError('site_publication_unavailable',503);
    if(url.search||!uuid.test(publication[1]))throw new ServiceError('invalid_operations_query');
    send(200,await contentPublications.get(actor,publication[1]));return true;
  }
  if (request.method==='GET'&&url.pathname==='/v1/operations/jobs') {
    await portal.authorizeOperator(request,{write:false,requestId,action:'jobs.read'});
    if (!operationsJobs) throw new ServiceError('operations_jobs_unavailable',503);
    const {queue,...query}=page(url); send(200,{queue,...await operationsJobs.list(queue,query)}); return true;
  }
  const jobRead=/^\/v1\/operations\/jobs\/(information-watch|search-recovery|content-publication|account-notice|retention-cleanup|messaging-run|messaging-delivery)\/([0-9a-f-]{36})$/.exec(url.pathname);
  if(request.method==='GET'&&jobRead){
    await portal.authorizeOperator(request,{write:false,requestId,action:'jobs.read'});
    if(!operationsJobs)throw new ServiceError('operations_jobs_unavailable',503);
    if(url.search||!uuid.test(jobRead[2]))throw new ServiceError('invalid_operations_query');
    send(200,{job:await operationsJobs.get(jobRead[1],jobRead[2])});return true;
  }
  const job=/^\/v1\/operations\/jobs\/(information-watch|search-recovery|content-publication|account-notice|retention-cleanup|messaging-run|messaging-delivery)\/([0-9a-f-]{36})\/(cancel|retry)$/.exec(url.pathname);
  if (request.method==='POST'&&job) {
    const permission='jobs.'+job[3],actor=await auditCommand(await portal.authorizeOperator(request,{write:true,requestId,action:permission}),permission);
    if (!operationsJobs) throw new ServiceError('operations_jobs_unavailable',503);
    if (url.search||!uuid.test(job[2])) throw new ServiceError('invalid_operations_query');
    await body(request,[]);
    let actual=actor;
    const domain=job[1]==='content-publication'?'cms.publish':['account-notice','messaging-run','messaging-delivery'].includes(job[1])?(job[3]==='cancel'?'notices.withdraw':'notices.publish')
      :job[1]==='retention-cleanup'?'retention.request':job[1]==='search-recovery'?'search.retry':null;
    const authorize=async tx=>{actual=await auditCommand(actor,permission,tx);if(domain)actual=await auditCommand(actual,domain,tx);};
    const audit=(tx,result)=>businessAdmin.recordWithin(tx,actual,'job-'+job[3],{
      selection:{queue:result.queue,jobId:result.jobId,...(result.generation?{generation:result.generation}:{})},
      result:{state:result.state,previousState:result.previousState,changed:result.changed}});
    send(200,await operationsJobs[job[3]](job[1],job[2],{audit,authorize,endpoint:actor.endpoint})); return true;
  }
  if (request.method==='GET'&&url.pathname==='/v1/operations/search/failures') {
    await portal.authorizeOperator(request,{write:false,requestId,action:'search.read'});
    if (!searchIndex) throw new ServiceError('operations_search_unavailable',503);
    const query=page(url); send(200,await searchIndex.failures({after:query.after,limit:query.limit})); return true;
  }
  const searchRead=/^\/v1\/operations\/search\/failures\/([0-9a-f-]{36})$/.exec(url.pathname);
  if(request.method==='GET'&&searchRead){
    await portal.authorizeOperator(request,{write:false,requestId,action:'search.read'});
    if(!searchIndex)throw new ServiceError('operations_search_unavailable',503);
    if(url.search||!uuid.test(searchRead[1]))throw new ServiceError('invalid_operations_query');
    send(200,{job:await searchIndex.failureStatus(searchRead[1])});return true;
  }
  const retry=/^\/v1\/operations\/search\/failures\/([0-9a-f-]{36})\/retry$/.exec(url.pathname);
  if (request.method==='POST'&&retry) {
    const actor=await auditCommand(await portal.authorizeOperator(request,{write:true,requestId,action:'search.retry'}),'search.retry');
    if (!searchIndex) throw new ServiceError('operations_search_unavailable',503);
    if (url.search||!uuid.test(retry[1])) throw new ServiceError('invalid_operations_query');
    const input=await body(request,['expectedGeneration']);
    let actual=actor;
    const authorize=async tx=>{actual=await auditCommand(actor,'search.retry',tx);};
    const audit=(tx,result)=>businessAdmin.recordWithin(tx,actual,'search-retry',{
      selection:{jobId:result.jobId,generation:result.generation},result:{state:result.state,changed:true}});
    send(200,await searchIndex.retryFailed({jobId:retry[1],expectedGeneration:input.expectedGeneration},{audit,authorize})); return true;
  }
  // Business API dispatch follows this adapter and independently authorizes.
  return false;
}
