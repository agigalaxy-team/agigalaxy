import { createCapsuleWebClient } from './capsule-workspace-client.mjs';
import {qualificationCalculationSchema} from '../../galaxy-official/src/shared/qualification-calculation-schema.mjs';
import {taskMaterialDerivedView} from './task-material-client.mjs';
export function createQualificationPermissionClient({
  runtime,
  subjectId,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const api = runtime.api,
    journal = createCapsuleWebClient({
      api,
      getLocal: runtime.getLocal,
      putLocal: runtime.putLocal,
      subjectId,
      operationFamily: 'qualification',
      now,
    });
  const endpoint=api.endpoint;
  const query = async (path, input, options={}) => {
    const lease=runtime.receiptStatus?.captureLease?.();lease?.assertCurrent();
    if (api.endpoint!==endpoint||api.snapshot()?.subjectId !== subjectId)
      throw Error('请连接当前身份。');
    const result=await api.call(path,input,{authenticated:true,...options});lease?.assertCurrent();
    if(api.endpoint!==endpoint||api.snapshot()?.subjectId!==subjectId)throw Error('qualification_current_identity_changed');return result;
  };
  const unavailable=error=>[403,404,409,410,422,503].includes(error?.status);
  async function grantDetails(grant){
    const lease=runtime.receiptStatus?.captureLease?.();lease?.assertCurrent();
    if(!grant.payload)return{id:grant.id,target:null,materials:[]};
    const payload=qualificationCalculationSchema.parse(grant.payload);
    if(payload.kind==='revoke'||payload.id!==grant.id)throw Error('qualification_grant_reference_mismatch');
    const short=value=>typeof value==='string'?value.slice(0,320):null;
    const targetPromise=(async()=>{try{const task=await query('/v2/tasks/'+payload.taskId,undefined,{method:'GET'}),title=task.request?.title??task.snapshot?.request?.title;
      return typeof title==='string'?taskMaterialDerivedView(task,{taskId:payload.taskId,title}):null;
    }catch(error){lease?.assertCurrent();if(!unavailable(error))throw error;return null;}})().then(value=>({value}),error=>({error}));
    const materials=[];
    for(let offset=0;offset<payload.sourceRefs.length;offset+=4){
      const page=await Promise.all(payload.sourceRefs.slice(offset,offset+4).map(async ref=>{
        const empty={ref,available:false,label:null,title:null,summary:null};
        if(!['case-event','task-event'].includes(ref.kind))return{...empty,reason:'current-source-reference-unresolved'};
        try{const current=await query('/v2/contributions/read',{source:ref,purpose:'honor'});lease?.assertCurrent();
          // A purpose-limited public contribution must not become a material
          // permission's implicit source-reading grant. This view needs the
          // independent current original projection; the API checks it afresh.
          if(current.publicationIds?.length)return{...empty,reason:'independent-source-read-required'};
          if(current.sourceState!=='currently-authorized-projection')return{...empty,reason:'current-source-unavailable'};
          const value=current.projection;return taskMaterialDerivedView(value,{ref,available:true,label:value.eventType??null,title:short(value.title),summary:short(value.summary??value.scope)});
        }catch(error){lease?.assertCurrent();if(!unavailable(error))throw error;return{...empty,reason:'current-source-unavailable'};}
      }));lease?.assertCurrent();materials.push(...page);
    }
    const target=await targetPromise;lease?.assertCurrent();if('error'in target)throw target.error;return{id:grant.id,target:target.value,materials};
  }
  const root = '/v2/qualification/permission-requests/';
  return {
    ...journal,
    plan: (input) => query(root + 'plan', input),
    requests: (input) => query(root + 'query', input),
    request: (requestId) => query(root + 'read', { requestId }),
    grants: (input) => query('/v2/qualification/calculation-owned', input),
    grantDetails,
    prepareRequest: (plan, author) =>
      journal.prepare(
        'qualification-request',
        {
          kind: 'request',
          eventId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          expectedVersion: 0,
          taskId: plan.taskId,
          sourceAuthorId: author.sourceAuthorId,
          participationIds: plan.compute.evidence.participationIds,
          externalReviewRefs: plan.compute.evidence.externalReviewRefs ?? [],
          sourceRefs: author.sourceRefs,
          expiresAt: plan.expiresAt,
          purpose:
            'request-scoped-qualification-permission-only; no-permission-granted',
        },
        { viewers: [author.sourceAuthorId] },
      ),
    prepareResponse: (request, kind, extra = {}) =>
      journal.prepare(
        'qualification-request',
        {
          kind,
          eventId: crypto.randomUUID(),
          requestId: request.requestId,
          expectedVersion: request.version,
          ...extra,
        },
        { viewers: [request.candidateId, request.sourceAuthorId] },
      ),
    preparePermission: (request) => {
      if (
        request.role !== 'source-author' ||
        request.state !== 'pending' ||
        !request.grant
      )
        throw Error('当前没有可授予的本人来源许可。');
      return journal.prepare(
        'qualification-grant',
        { ...request.grant, id: crypto.randomUUID() },
        { viewers: [request.candidateId, request.recipientId] },
      );
    },
    prepareCompute: (plan) => {
      if (!plan.ready) throw Error('请先收集每位来源作者的限定许可。');
      return journal.prepare(
        'qualification-grant',
        { ...plan.compute, id: crypto.randomUUID() },
        { viewers: [plan.recipientId] },
      );
    },
    prepareRevoke: (grant, reason) => {
      if (!grant.payload) throw Error('原许可意图当前不可读取。');
      return journal.prepare(
        'qualification-grant',
        { id: crypto.randomUUID(), kind: 'revoke', grantId: grant.id, reason },
        {
          grantKind: grant.payload.kind,
          viewers: [grant.payload.candidateId, grant.payload.recipientId],
        },
      );
    },
  };
}
