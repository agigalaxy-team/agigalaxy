import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture as qualificationFixture,nativeWork,target,cg,ag} from './qualification-v2-workflow.mjs';
import {HonorService} from "../src/records/honor.mjs";
import {HonorV2Service} from "../src/records/honor-v2.mjs";
import {createApi} from '../src/http.mjs';
import {digest} from '../src/shared/digest.mjs';

// Synthetic work only. Real signed HTTP, Case/Task services and PGlite execute;
// body erasure models retained metadata, not a deletion-worker acceptance.
async function fixture(){
  const {f,p}=await qualificationFixture(null,{extraScopes:['history']});let api;
  try{
    const policy={id:'retained-version',version:'1',sourceProfile:'facts-v2',title:'Synthetic source support',
      capabilityId:'software-debugging',communityId:'synthetic',kind:'open-contributor',
      members:[f.actor.subjectId,p.actor.subjectId],relatedPartyGroups:[],notBefore:f.now-1,notAfter:f.now+1000,
      windowFrom:f.now-86400,windowUntil:f.now+1,minAcceptedCases:1,minProofs:0,repositories:[],
      rankingEnabled:false,privacyReview:'pending',minimumCohort:5,minimumCasesPerMember:3};
    f.honor=new HonorService(f.access,f.assistance,f.proofs,[policy]);
    f.honor.v2=new HonorV2Service(f.honor,{qualification:f.qualification.v2,sharing:f.contributionSharing});
    api=createApi({...f,rateLimit:1000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const originals=new Map(),erased=new Set();
    const request=async(who,path,input)=>{
      const response=await fetch(`http://127.0.0.1:${api.address().port}${path}`,{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${who.credential}`},body:JSON.stringify(input)});
      return{status:response.status,value:await response.json()};
    };
    const post=async(who,path,input)=>{const got=await request(who,path,input);assert.equal(got.status,200,JSON.stringify(got.value));return got.value;};
    const remember=async()=>{for(const row of (await f.db.query('SELECT * FROM case_events')).rows)
      if(!originals.has(row.id))originals.set(row.id,row);};
    const write=async(who,event,viewers=[])=>{
      const signed=await cg(who,event,viewers),receipt=await post(who,'/v2/cases/events',signed);await remember();
      return{signed,receipt,event};
    };
    const event=async(who,r,kind,fields={})=>({schemaVersion:2,kind,eventId:randomUUID(),caseId:r.caseId,
      actorId:who.actor.subjectId,expectedVersion:(await f.db.query('SELECT version FROM cases WHERE id=$1',[r.caseId])).rows[0].version,...fields});
    const root=async(who=f)=>{const id=randomUUID(),r={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,
      actorId:who.actor.subjectId,expectedVersion:0,localRef:randomUUID(),title:'FICTIONAL retained version',
      summary:'Synthetic canonical source test',source:{kind:'local',reference:randomUUID()},synthetic:true};
      await write(who,r);return r;};
    const diagnosis=async(who,r,fields={})=>event(who,r,'intervention',{types:['diagnosis'],affectsAttemptIds:[],
      description:'FICTIONAL independent intervention',sourceRefs:[],observedEffect:'Only limited self-report',...fields});
    const start=async(who,r)=>event(who,r,'attempt-start',{role:'diagnosis',strategy:'FICTIONAL finite attempt',
      inputScopeSummary:'Synthetic selected input',permissionScope:['selected-input']});
    const result=async(who,r,origin,fields={})=>event(who,r,'result-recorded',{origin,scopeVersion:1,deliverableRefs:[],
      reportedOutcome:'partial',summary:'FICTIONAL limited result',limitations:'Not verified expertise',...fields});
    const erase=async(e)=>{
      const read=async()=>(await f.db.query('SELECT id,case_id,subject_id,kind,version,consent_id,payload_hash,created_at FROM case_events WHERE id=$1',[e.eventId])).rows[0];
      const before=await read();await f.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1",[e.eventId]);
      assert.deepEqual(await read(),before);erased.add(e.eventId);
    };
    const reject=async(who,e)=>{
      const before=(await f.db.query('SELECT version FROM cases WHERE id=$1',[e.caseId])).rows[0].version;
      const count=(await f.db.query('SELECT count(*)::int AS count FROM case_events WHERE case_id=$1',[e.caseId])).rows[0].count;
      const signed=await cg(who,e),got=await request(who,'/v2/cases/events',signed);
      assert.equal(got.status,409,JSON.stringify(got.value));assert.equal(got.value.error,'fact_currentness_unavailable');
      for(const id of erased)assert.equal(JSON.stringify(got.value).includes(id),false);
      assert.equal((await f.db.query('SELECT version FROM cases WHERE id=$1',[e.caseId])).rows[0].version,before);
      assert.equal((await f.db.query('SELECT count(*)::int AS count FROM case_events WHERE case_id=$1',[e.caseId])).rows[0].count,count);
      const receipt=await post(who,'/v2/cases/events/receipt',{caseId:e.caseId,eventId:e.eventId,payloadHash:digest(signed.payloadJson)});
      assert.equal(receipt.state,'absent');
    };
    const bytes=async()=>{for(const [id,original]of originals){
      const row=(await f.db.query('SELECT * FROM case_events WHERE id=$1',[id])).rows[0];
      assert.equal(row.payload_hash,original.payload_hash);
      if(!erased.has(id))assert.equal(row.payload_text,original.payload_text);
      else assert.equal(row.payload_text,'');
    }};
    const oldReceipt=async(who,written)=>{const got=await post(who,'/v2/cases/events/receipt',{
      caseId:written.event.caseId,eventId:written.event.eventId,payloadHash:digest(written.signed.payloadJson)});
      assert.equal(got.state,'acknowledged');assert.equal(got.currentAccessGranted,false);
      assert.equal(got.caseVersion,written.receipt.caseVersion);};
    const read=(who,r)=>post(who,`/v2/cases/${r.caseId}/read`,{});
    const close=async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();};
    return{f,p,policy,post,write,event,root,diagnosis,start,result,erase,reject,bytes,oldReceipt,read,remember,close};
  }catch(error){if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await f.db.close();throw error;}
}

test('erased accepted Result v2 cannot be reused; new independent Result needs new exact delivery and acceptance for Qualification/Honor',async()=>{
  const h=await fixture();try{
    const {f,p}=h,work=await nativeWork(f,p),t=await target(f,p);await h.remember();
    const query=async()=>{
      const qualification=await h.post(p,'/v2/qualification/evaluate',{taskId:t.taskId,subjectId:p.actor.subjectId,
        evidence:{participationIds:[work.proposal.participationId]},includeSimulation:true});
      const honor=await h.post(p,'/v2/honor/query',{subjectId:p.actor.subjectId,ruleId:h.policy.id,ruleVersion:'1',includeSimulation:true});
      assert.equal(qualification.state,'insufficient-evidence');assert.equal(honor.card.acceptedCases,0);
      return{qualification,honor};
    };
    const support=async(yes)=>{const q=await query();assert.equal(q.qualification.simulation.state,yes?'satisfied':'insufficient-evidence');
      assert.equal(q.honor.simulation.distinctCases,yes?1:0);return q;};
    const deliver=async(id,version,expected)=>{
      const e={...work.delivery,eventId:randomUUID(),expectedParticipationVersion:expected,resultRef:{id,version},summary:'FICTIONAL explicit exact new delivery'};
      await h.post(p,`/v2/participations/${work.proposal.participationId}/events`,await ag(p,e,[f.actor.subjectId]));return e;
    };
    const accept=async(e,expected)=>h.post(f,`/v2/participations/${work.proposal.participationId}/events`,
      await ag(f,{eventId:randomUUID(),kind:'accept',expectedParticipationVersion:expected,deliveryId:e.eventId,
        summary:'FICTIONAL accept exact new work'},[p.actor.subjectId]));
    await support(true);
    const changed={...work.result,eventId:randomUUID(),expectedVersion:4,supersedes:{id:work.result.eventId,version:1},summary:'FICTIONAL first v2'};
    const old=await h.write(p,changed,[f.actor.subjectId]),delivery=await deliver(work.result.eventId,2,4);
    await accept(delivery,5);await support(true);
    await h.post(p,`/v1/consents/${old.signed.consentId}/revoke`,{});await support(false);
    await h.erase(changed);await support(false);
    await h.reject(p,{...changed,eventId:randomUUID(),expectedVersion:5,summary:'FICTIONAL different body cannot reuse v2'});
    await h.oldReceipt(p,old);
    const fresh={...work.result,eventId:randomUUID(),expectedVersion:5,supersedes:null,summary:'FICTIONAL independent current Result'};
    const added=await h.write(p,fresh,[f.actor.subjectId]);assert.deepEqual(added.receipt.objectRef,{id:fresh.eventId,version:1});
    const unavailable=await support(false);assert.equal(JSON.stringify(unavailable).includes(changed.eventId),false);
    const newDelivery=await deliver(fresh.eventId,1,6);await support(false);
    await accept(newDelivery,7);await support(true);await h.bytes();
  }finally{await h.close();}
});

test('erased attempt-end cannot make running v1 current again; a new independent Attempt can end and be corrected',async()=>{
  const h=await fixture();try{
    const r=await h.root(),start=await h.start(h.f,r);await h.write(h.f,start);
    const end=await h.event(h.f,r,'attempt-end',{attemptRef:{id:start.eventId,version:1},status:'canceled',
      summary:'FICTIONAL original cancellation',failureReason:'unknown'});
    const original=await h.write(h.f,end);await h.erase(end);
    await h.reject(h.f,{...end,eventId:randomUUID(),expectedVersion:3,summary:'FICTIONAL duplicate v2'});
    await h.oldReceipt(h.f,original);
    const fresh=await h.start(h.f,r);await h.write(h.f,fresh);
    const next=await h.event(h.f,r,'attempt-end',{attemptRef:{id:fresh.eventId,version:1},status:'completed',
      summary:'FICTIONAL fresh end',failureReason:'No claimed cause'});
    await h.write(h.f,next);
    await h.write(h.f,await h.event(h.f,r,'attempt-correct',{attemptRef:{id:fresh.eventId,version:2},status:'inconclusive',
      summary:'FICTIONAL explicit correction',failureReason:'unknown',reason:'New limited observation'}));
    const view=await h.read(h.f,r);assert.equal(view.attempts.filter(a=>a.id===fresh.eventId).at(-1).version,3);
    await h.bytes();
  }finally{await h.close();}
});

test('erased attempt-correct cannot reuse terminal v2; nonlatest historical source and exact original receipt remain readable',async()=>{
  const h=await fixture();try{
    const r=await h.root(),start=await h.start(h.f,r);await h.write(h.f,start);
    const end=await h.event(h.f,r,'attempt-end',{attemptRef:{id:start.eventId,version:1},status:'completed',
      summary:'FICTIONAL original finite work',failureReason:'Not a failure claim'});await h.write(h.f,end);
    const correction=await h.event(h.f,r,'attempt-correct',{attemptRef:{id:start.eventId,version:2},status:'inconclusive',
      summary:'FICTIONAL original v3',failureReason:'unknown',reason:'Correct limited observation'});
    const original=await h.write(h.f,correction);await h.erase(correction);
    await h.reject(h.f,{...correction,eventId:randomUUID(),expectedVersion:4,summary:'FICTIONAL must not reuse v3'});
    const history=await h.result(h.f,r,{kind:'attempt',id:start.eventId,version:2});
    await h.write(h.f,history);
    const view=await h.read(h.f,r);assert.equal(view.results[0].origin.version,2);
    assert.equal(view.attempts.find(a=>a.id===start.eventId&&a.version===2).summary,end.summary);
    await h.oldReceipt(h.f,original);await h.bytes();
  }finally{await h.close();}
});

test('erased Intervention blocks old supersession and new response without inventing target; later independent target has a legal latest path',async()=>{
  const h=await fixture();try{
    const r=await h.root(),first=await h.diagnosis(h.f,r);await h.write(h.f,first);
    const correction=await h.diagnosis(h.f,r,{supersedes:{id:first.eventId,version:1},description:'FICTIONAL private newer v2'});
    const original=await h.write(h.f,correction);await h.erase(correction);
    await h.reject(h.f,await h.diagnosis(h.f,r,{supersedes:{id:first.eventId,version:1}}));
    await h.reject(h.f,await h.event(h.f,r,'intervention-response',{interventionRef:{id:first.eventId,version:1},
      state:'accepted',summary:'FICTIONAL latest is unknown'}));
    const fresh=await h.diagnosis(h.f,r);await h.write(h.f,fresh);
    await h.write(h.f,await h.event(h.f,r,'intervention-response',{interventionRef:{id:fresh.eventId,version:1},
      state:'accepted',summary:'FICTIONAL explicit self opinion'}));
    await h.write(h.f,await h.diagnosis(h.f,r,{supersedes:{id:fresh.eventId,version:1},description:'FICTIONAL new target v2'}));
    const view=await h.read(h.f,r);assert.equal(view.interventions.filter(i=>i.id===fresh.eventId).at(-1).version,2);
    assert.equal(view.interventions.find(i=>i.id===fresh.eventId&&i.version===1).confirmation,'unconfirmed');
    await h.oldReceipt(h.f,original);await h.bytes();
  }finally{await h.close();}
});

test('retained currentness guard distinguishes author, Case, fact kind and earlier unknown rows without timestamp inference',async()=>{
  const h=await fixture();try{
    const work=await nativeWork(h.f,h.p);await h.remember();
    const own={caseId:work.cid},foreign=await h.diagnosis(h.f,own);
    await h.write(h.f,foreign,[h.p.actor.subjectId]);await h.erase(foreign);
    const participant=await h.diagnosis(h.p,own,{taskId:work.open.taskId,participationId:work.proposal.participationId,
      supersedes:{id:work.intervention.eventId,version:1}});
    await h.write(h.p,participant,[h.f.actor.subjectId]);
    await h.write(h.p,await h.diagnosis(h.p,own,{taskId:work.open.taskId,participationId:work.proposal.participationId,
      supersedes:{id:work.intervention.eventId,version:2}}),[h.f.actor.subjectId]);
    // Same author, same Case, other fact kind is not a mutation of this Attempt.
    const running=await h.start(h.f,own);await h.write(h.f,running);
    const hidden=await h.diagnosis(h.f,own);await h.write(h.f,hidden);await h.erase(hidden);
    await h.write(h.f,await h.event(h.f,own,'attempt-end',{attemptRef:{id:running.eventId,version:1},status:'canceled',
      summary:'FICTIONAL independent kind',failureReason:'unknown'}));
    // Another Case cannot contaminate current source; same timestamp never replaces Case order.
    const other=await h.root(),otherStart=await h.start(h.f,other);await h.write(h.f,otherStart);
    const otherEnd=await h.event(h.f,other,'attempt-end',{attemptRef:{id:otherStart.eventId,version:1},status:'canceled',
      summary:'FICTIONAL unrelated Case row',failureReason:'unknown'});await h.write(h.f,otherEnd);await h.erase(otherEnd);
    await h.f.db.query('UPDATE case_events SET created_at=$1',[new Date(h.f.now*1000).toISOString()]);
    await h.write(h.f,await h.event(h.f,own,'attempt-correct',{attemptRef:{id:running.eventId,version:2},status:'inconclusive',
      summary:'FICTIONAL original Case remains current',failureReason:'unknown',reason:'Explicit correction'}));
    await h.bytes();
  }finally{await h.close();}
});
