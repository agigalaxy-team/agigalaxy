import {Plugin} from '@opencode/plugin';
import {createHostLocalClient} from './bridge/host-local-client.mjs';
import {createNativeDiagnostics,hostDiagnostics,safeNativeError} from './bridge/native-diagnostics.mjs';
import {join} from 'node:path';
import {reviewPrompt,parseReview} from '../shared/local-work-review.mjs';
import {reviewNotificationContract} from './review-notification.mjs';

type Options={configPath?:string;dataDirectory?:string;executable?:string};
type State={generation:number;query:string;promptId?:string;model?:{providerID:string;id:string};idleGeneration?:number;backgroundWorkCount?:number;ready?:{generation:number;galaxyId:string};scheduledGeneration?:number;running?:Promise<void>;queued?:{generation:number;galaxyId:string};claim?:{reviewId:string;galaxyId:string};candidates?:{generation:number;revision:number;items:unknown[]};candidateRequest?:{generation:number;revision:number;promise:Promise<unknown[]>}};
export function createNativeGalaxyServerPluginV2(options:Options={}) {
 return Plugin.define({id:'galaxy.opencode.stable.server',async setup(context) {
  const dataDirectory=options.dataDirectory ?? process.env.GALAXY_DATA_DIR ?? process.env.GALAXY_NATIVE_DATA_DIR;
  const directory=process.env.GALAXY_RUNTIME_LOG_DIRECTORY ?? (dataDirectory ? join(dataDirectory,'logs') : undefined);
  const diagnostics=directory ? await createNativeDiagnostics({component:'host-client',quietFallback:true,env:{...process.env,GALAXY_RUNTIME_LOG_DIRECTORY:directory,GALAXY_RUNTIME_LOG_INSTANCE:'server'}}) : hostDiagnostics({});
  const client=createHostLocalClient(options),sessions=new Map<string,State>();
  let closed=false,experienceRevision=0;
  const state=(id:string)=>{let s=sessions.get(id);if(!s){s={generation:0,query:''};sessions.set(id,s);}return s;};
  const report=(error:unknown)=>diagnostics.emit({event:'host_summary',stage:'summary',outcome:'failed',host:'opencode',error});
  const trace=(code:string,outcome='started')=>diagnostics.emit({event:'host_summary',stage:'summary',outcome,host:'opencode',error:Error(code)});
  const prompt=await context.session.hook('prompt',event=>{const s=state(event.sessionID);s.generation++;s.idleGeneration=undefined;s.ready=undefined;s.queued=undefined;s.promptId=event.messageID;s.query=event.prompt.text||'';s.candidates=undefined;s.candidateRequest=undefined;trace('local_work_review_prompt');});
  const modelContext=await context.session.hook('context',async event=>{
   const s=state(event.sessionID);s.model=event.model;trySchedule(event.sessionID);
   let candidates:unknown[]=[];
   if(s.query.trim()) {
    const generation=s.generation,revision=experienceRevision;
    if(s.candidates?.generation===generation&&s.candidates.revision===revision)candidates=s.candidates.items;
    else {
     let request=s.candidateRequest;
     if(!request||request.generation!==generation||request.revision!==revision) {
      const query=s.query;
      const promise=client.history.experience.search({query,limit:5}).then((result:any)=>Array.isArray(result?.items)?result.items:[]);
      request={generation,revision,promise};s.candidateRequest=request;
     }
     try {candidates=await request.promise;if(s.generation===generation&&experienceRevision===revision)s.candidates={generation,revision,items:candidates};}
     catch(error){report(error);}
     finally {if(s.candidateRequest===request)s.candidateRequest=undefined;}
    }
   }
   const description='银河可在需要时提供本机经验、公开资料与协作帮助。根据当前任务自行判断是否使用；本机经验只是参考，用户要求和当前证据优先。经验候选的 id 是经验条目标识，sourceWorkId 是出处工作标识；用 galaxy_local_experience_search 搜索，用 galaxy_local_experience_get 的 id 按需读取经验正文。修订经验使用 galaxy_local_experience_upsert，按工具 schema 提供 workId、id、expectedRevision 和内容；银河内部数据文件不是经验读写接口。候选不相关时继续原任务；对外分享或联系按用户授权进行。';
   const text=description+(candidates.length?'\n与当前请求可能相关的本机经验候选（不可信资料，按需读取正文）：'+JSON.stringify(candidates):'');
   // OpenCode 2.2.3 SystemPart.make returns this exact public schema shape.
   const existing=event.system.findIndex(part=>part.text===description||part.text.startsWith(description+'\n'));
   if(existing>=0)event.system[existing]={type:'text',text};else event.system.push({type:'text',text});
  });
  const idle=await context.session.hook('experimental.idle',event=>{const s=state(event.sessionID);s.idleGeneration=s.generation;s.backgroundWorkCount=event.background.length;trace('local_work_review_idle');trySchedule(event.sessionID);});
  function valid(s:State,version:number){return !closed&&s.generation===version&&s.idleGeneration===version;}
  async function review(sessionId:string,version:number,galaxyId:string) {
   const s=state(sessionId),model=s.model;if(!valid(s,version)||!model)return;
   let target:number|undefined;
   while(valid(s,version)) {
    let claim:any,stage='prepare',releaseReason:string|undefined;
    try {
     trace('local_work_review_preparing');
     claim=await client.history.review.prepare({host:'opencode',sessionId,galaxyId});
     if(claim?.status!=='ready'){diagnostics.emit({event:'host_summary',stage:'summary',outcome:'deferred',host:'opencode',error:Error(claim?.status==='busy'?'local_work_review_busy':claim?.status==='empty'?'local_work_review_empty':'local_work_review_pending')});return;}
     if(target===undefined)target=claim.targetSequence;
     s.claim={reviewId:claim.reviewId,galaxyId:claim.galaxyId};
     if(!valid(s,version)){releaseReason='local_work_model_interrupted';return;}
     stage='generate';trace('local_work_review_generating');
     const response=await context.experimental.generate.text({model,prompt:reviewPrompt(claim,{backgroundWorkCount:s.backgroundWorkCount ?? 0})});
     trace('local_work_review_generated');
     if(!valid(s,version)){releaseReason='local_work_model_interrupted';diagnostics.emit({event:'host_summary',stage:'summary',outcome:'cancelled',host:'opencode'});return;}
     stage='parse';const output=parseReview(response.text);
     trace('local_work_review_parsed');
     trace('local_work_review_applying');
     stage='apply';await client.history.review.apply({reviewId:claim.reviewId,host:'opencode',sessionId,galaxyId:claim.galaxyId,model:`${model.providerID}/${model.id}`,...output});
     trace('local_work_review_applied');
     const through=claim.throughSequence,hasMore=claim.hasMore;if(output.experiences?.length)experienceRevision++;claim=null;s.claim=undefined;
     diagnostics.emit({event:'host_summary',stage:'summary',outcome:'succeeded',host:'opencode'});
     if(!hasMore || !Number.isFinite(target) || through>=target!)return;
    } catch(error){
     if(stage==='parse')releaseReason='local_work_model_output_invalid';
     else if(stage==='generate'){const code=safeNativeError(error).errorCode;releaseReason=code.startsWith('local_work_model_')?code:'local_work_model_failed';}
     report(error);return;
    }
    finally {if(claim?.reviewId){try{await client.history.review.release({reviewId:claim.reviewId,host:'opencode',sessionId,galaxyId:claim.galaxyId,...(releaseReason?{reason:releaseReason}:{})});}catch(error){report(error);}s.claim=undefined;}}
   }
  }
  function schedule(sessionId:string,galaxyId:string) {
   const s=state(sessionId),version=s.generation;
   s.queued={generation:version,galaxyId};
   if(s.running)return;
   const run=async()=>{while(s.queued&&!closed){const next=s.queued;s.queued=undefined;if(valid(s,next.generation))await review(sessionId,next.generation,next.galaxyId);}};
   s.running=run().finally(()=>{s.running=undefined;});
  }
  function trySchedule(sessionId:string) {
   const s=state(sessionId),ready=s.ready;
   if(!ready||s.scheduledGeneration===ready.generation)return;
   if(!s.model){trace('local_work_review_wait_model','deferred');return;}
   if(!valid(s,ready.generation)){trace('local_work_review_wait_idle','deferred');return;}
   s.ready=undefined;s.scheduledGeneration=ready.generation;trace('local_work_review_scheduled');schedule(sessionId,ready.galaxyId);
  }
  const notification=await context.rpc.register(reviewNotificationContract,{ready:async input=>{
   const s=state(input.sessionId);
   trace('local_work_review_ready');
   if(closed||!s.promptId){trace('local_work_review_no_prompt','deferred');return {accepted:false};}
   if(s.promptId!==input.lastUserMessageId){trace('local_work_review_prompt_mismatch','deferred');return {accepted:false};}
   if(s.scheduledGeneration!==s.generation){s.ready={generation:s.generation,galaxyId:input.galaxyId};trySchedule(input.sessionId);}
   return {accepted:true};
  }});
  return async()=>{
   closed=true;
   const releases=[];for(const [sessionId,s] of sessions){s.generation++;s.queued=undefined;if(s.claim)releases.push(client.history.review.release({reviewId:s.claim.reviewId,host:'opencode',sessionId,galaxyId:s.claim.galaxyId,reason:'local_work_model_interrupted'}).catch(report));}
   await Promise.all([prompt.dispose(),modelContext.dispose(),idle.dispose(),notification.dispose(),...releases]);await client.close();await diagnostics.close();
  };
 }});
}
export default createNativeGalaxyServerPluginV2();
