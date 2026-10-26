import { sha256Hex } from "../../../../galaxy-official/src/shared/web-primitives.mjs";
import { searchV2Scope } from "../../../../galaxy-official/src/shared/search-v2-schema.mjs";

const copy = value => structuredClone(value);
const key = (type, ref) => `${type}:${ref.id}:${ref.version}`;
const message = error => error?.code ?? error?.message ?? 'source_unavailable';

/** @param {any} runtime
 * @param {{authenticated?:boolean,subjectId?:string|null}} options */
export function createHelpSearchClient(runtime, { authenticated = false, subjectId = null } = {}) {
  const candidates = new Map(), visibleResults = new Map(); let serial = Promise.resolve(), closed = false, endpoint=runtime.api.endpoint??null;
  const check = () => { if (closed) throw new Error('search_client_closed'); };
  const begin = async () => { check(); const current = await runtime.status(); check();
    if ((current.identity?.subjectId??null)!==subjectId)throw new Error('search_identity_changed');
    const lease={subjectId,endpoint:current.endpoint??runtime.api.endpoint??null,bindingId:current.connection?.bindingId??null,generation:current.connection?.generation??null};
    endpoint??=lease.endpoint;if(endpoint!==lease.endpoint)throw new Error('search_connection_changed');return lease; };
  const same = async lease => {const current=await begin();if(Object.keys(lease).some(k=>lease[k]!==current[k]))throw new Error('search_connection_changed');};
  const guarded=async(lease,fn)=>{await same(lease);let value;try{value=await fn();}catch(error){await same(lease);throw error;}await same(lease);return value;};
  const readLocal = (lease,name) => guarded(lease,()=>runtime.getLocal(name));
  const writeLocal = (lease,name,value) => guarded(lease,()=>runtime.putLocal(name,value));
  const call = (lease,path,input,scope) => guarded(lease,()=>{
    const scopes=runtime.api.snapshot()?.scopes??[];
    // Public source reads remain anonymous when this exact device was not
    // granted that source. Sending an insufficient bearer would invalidate an
    // otherwise useful connection; it is not a request for more authority.
    return runtime.api.call(path,input,{authenticated:authenticated&&(scopes.includes(scope)||scopes.includes('*'))});
  });
  const local = async lease => { const value = await readLocal(lease,'help-choices-v2');
    return value ?? { schemaVersion: 2, storage: 'local', cloudSyncEnabled: false, choices: [], referenceStates: {} }; };
  const operation=async fn=>{const lease=await begin(),value=await fn(lease);await same(lease);return value;};
  const run = fn => { const pending=begin().then(lease=>({lease}),error=>({error})),result=serial.then(async()=>{const selected=await pending;if(selected.error)throw selected.error;
    await same(selected.lease);const value=await fn(selected.lease);await same(selected.lease);return value;}); serial = result.catch(() => {}); return result; };
  const query=search=>operation(lease=>queryWithin(lease,search));
  async function queryWithin(lease,search) {
    const page = await call(lease,'/v2/search/query',search,searchV2Scope(search.type));
    for (const item of page.items) {
      candidates.set(key(item.type,item.ref), { ref:{type:item.type,...item.ref}, search:copy(search), checkedAt:page.checkedAt });
      for(const result of item.record?.results??[])if(!result.supersededInVisibleHistory)
        visibleResults.set(`${item.record.caseId}:${result.id}:${result.version}`, {caseId:item.record.caseId,id:result.id,version:result.version});
    }
    return page;
  }
  return {
    query, local:()=>operation(local),
    /** @param {unknown} item
     * @param {{after?:string|null}} [options] */
    async detail(item,{after=null}={}) {
      const lease=await begin();
      const selected=candidates.get(key(item.type,item.ref));if(!selected)throw new Error('choice_source_not_read_in_this_client');
      if(item.type==='capsule')return call(lease,'/v2/capsules/read',{capsuleId:item.id,versionId:item.source.versionId},'capsules');
      if(item.type==='opportunity')return call(lease,'/v2/discovery/detail',{context:selected.search.query.context,purposes:selected.search.query.purposes,
        opportunityRef:item.source,experienceLimit:8,experienceAfter:after},'history');
      return call(lease,'/v2/search/reference',{search:selected.search,ref:item.ref},searchV2Scope(selected.search.type));
    },
    async combine(searches) {
      if (!Array.isArray(searches) || searches.length < 1 || searches.length > 8) throw new Error('invalid_source_bundle');
      const lease=await begin(),results = await Promise.allSettled(searches.map(search=>queryWithin(lease,search))); await same(lease);
      return { interpretation:'user-or-user-agent', persistedQuery:false,
        sources:results.map((result,index) => result.status === 'fulfilled'
          ? {type:searches[index].type,state:'fulfilled',page:result.value}
          : {type:searches[index].type,state:'failed',error:message(result.reason),page:null}),
        hasPartialFailure:results.some(r=>r.status==='rejected'),
        helpPaths:['continue-current-ai','capsule-or-history','open-assistance','bounty-or-expert-assistance'] };
    },
    saveChoice(input) { return run(async lease => {
      const {id,expectedVersion=0,localTaskRef,visibleRationale,rationaleAuthor,candidateKeys,selectedKeys=[],resultRefs=[]}=input;
      if (!/^[0-9a-f-]{36}$/.test(id) || !Number.isInteger(expectedVersion) || expectedVersion<0
        || typeof localTaskRef!=='string' || !localTaskRef.trim() || localTaskRef.length>300
        || typeof visibleRationale!=='string' || !visibleRationale.trim() || visibleRationale.length>1200
        || !['user','user-agent'].includes(rationaleAuthor) || !Array.isArray(candidateKeys) || candidateKeys.length<1 || candidateKeys.length>64
        || !Array.isArray(selectedKeys) || selectedKeys.some(k=>!candidateKeys.includes(k)) || resultRefs.length>16)
        throw new Error('invalid_choice_snapshot');
      const selected = candidateKeys.map(k => { const candidate=candidates.get(k); if(!candidate)throw new Error('choice_source_not_read_in_this_client'); return candidate; });
      // Result references are only linked when that exact visible result is in
      // a freshly read source. A selection or page read creates no Result.
      const actualResults=resultRefs.map(ref=>{const found=visibleResults.get(`${ref.caseId}:${ref.id}:${ref.version}`);
        if(!found)throw new Error('result_link_requires_actual_fact_workflow');return {...found};});
      const payload = { id,version:expectedVersion+1,localTaskRef,visibleRationale,rationaleAuthor,
        candidateRefs:selected.map(item=>item.ref),selectedRefs:selected.filter(item=>selectedKeys.includes(key(item.ref.type,item.ref))).map(item=>item.ref),
        resultRefs:actualResults,selectionMeaning:'user-selected-candidates; not-contacted-or-applied-or-successful' };
      const hash=await guarded(lease,()=>sha256Hex(JSON.stringify(payload))), data=await local(lease), existing=data.choices.find(c=>c.id===id);
      if(existing?.versions.some(v=>v.version===payload.version&&v.hash===hash))return copy(existing.versions.find(v=>v.hash===hash));
      if((existing?.versions.at(-1)?.version??0)!==expectedVersion)throw new Error('choice_version_conflict');
      const version={...payload,hash,recordedAt:new Date().toISOString()};
      if(existing)existing.versions.push(version);else data.choices.push({id,versions:[version]});
      // Capture the cloud revision when this local draft is made. Reading a
      // newer remote head later is not permission to rebase this old draft.
      const cloud=await readLocal(lease,'choice-cloud-v2'),bases=await readLocal(lease,'choice-cloud-bases-v2')??{};
      bases[`${id}:${hash}`]=cloud?.heads?.[id]?.revision??0;await writeLocal(lease,'choice-cloud-bases-v2',bases);
      // Query context is local navigation state, kept outside the minimal
      // choice payload. Neither it nor the choice is uploaded by this client.
      const lookups=await readLocal(lease,'help-choice-lookups-v2')??{};
      for(const item of selected)lookups[key(item.ref.type,item.ref)]=item.search;
      await writeLocal(lease,'help-choice-lookups-v2',lookups);await writeLocal(lease,'help-choices-v2',data);return copy(version);
    }); },
    refreshChoice(id) { return run(async lease => {
      const data=await local(lease), choice=data.choices.find(c=>c.id===id);if(!choice)throw new Error('choice_not_found');
      const lookups=await readLocal(lease,'help-choice-lookups-v2')??{};
      const refs=choice.versions.at(-1).candidateRefs;
      const results=await Promise.allSettled(refs.map(async ref=>{
        const search=lookups[key(ref.type,ref)];if(!search)throw new Error('choice_refresh_query_unavailable');
        return call(lease,'/v2/search/reference',{search,ref:{id:ref.id,version:ref.version}},searchV2Scope(search.type));
      }));await same(lease);
      for(let i=0;i<refs.length;i++){const r=results[i];data.referenceStates[key(refs[i].type,refs[i])]=r.status==='fulfilled'
        ? {state:r.value.state,priorRationaleCurrent:r.value.priorRationaleCurrent,checkedAt:r.value.checkedAt}
        : {state:'check-failed',priorRationaleCurrent:null,error:message(r.reason)};}
      await writeLocal(lease,'help-choices-v2',data);return copy(data);
    }); },
    removeChoice(id) { return run(async lease=>{const data=await local(lease);data.choices=data.choices.filter(c=>c.id!==id);
      const bases=await readLocal(lease,'choice-cloud-bases-v2')??{};await writeLocal(lease,'choice-cloud-bases-v2',Object.fromEntries(Object.entries(bases).filter(([k])=>!k.startsWith(id+':'))));
      const refs=new Set(data.choices.flatMap(c=>c.versions.flatMap(v=>v.candidateRefs.map(r=>key(r.type,r)))));
      data.referenceStates=Object.fromEntries(Object.entries(data.referenceStates).filter(([k])=>refs.has(k)));
      const lookups=await readLocal(lease,'help-choice-lookups-v2')??{};
      await writeLocal(lease,'help-choice-lookups-v2',Object.fromEntries(Object.entries(lookups).filter(([k])=>refs.has(k))));
      await writeLocal(lease,'help-choices-v2',data);return data;}); },
    close(){closed=true;candidates.clear();visibleResults.clear();}, candidateKey:(item)=>key(item.type,item.ref),
    resultReferences:()=>[...visibleResults.values()].map(copy),
  };
}
