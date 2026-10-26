import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,nativeWork,target,cg,ag} from './qualification-v2-workflow.mjs';
import {HonorService} from "../src/records/honor.mjs";
import {HonorV2Service} from "../src/records/honor-v2.mjs";
import {createApi} from '../src/http.mjs';

async function setup(){
  const {f,p}=await fixture(null,{extraScopes:['history']});let api;
  try{
    const work=await nativeWork(f,p),t=await target(f,p);
    const policy={id:'retained-result',version:'1',sourceProfile:'facts-v2',title:'Synthetic retained-source check',capabilityId:'software-debugging',communityId:'synthetic',kind:'open-contributor',members:[f.actor.subjectId,p.actor.subjectId],relatedPartyGroups:[],notBefore:f.now-1,notAfter:f.now+1000,windowFrom:f.now-86400,windowUntil:f.now+1,minAcceptedCases:1,minProofs:0,repositories:[],rankingEnabled:false,privacyReview:'pending',minimumCohort:5,minimumCasesPerMember:3};
    f.honor=new HonorService(f.access,f.assistance,f.proofs,[policy]);
    f.honor.v2=new HonorV2Service(f.honor,{qualification:f.qualification.v2,sharing:f.contributionSharing});
    api=createApi({...f,rateLimit:1000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const post=async(who,path,input)=>{
      const response=await fetch(`http://127.0.0.1:${api.address().port}${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(who?{Authorization:`Bearer ${who.credential}`}:{})},body:JSON.stringify(input)});
      const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
    };
    const input={taskId:t.taskId,subjectId:p.actor.subjectId,evidence:{participationIds:[work.proposal.participationId]},includeSimulation:true};
    const honorInput={subjectId:p.actor.subjectId,ruleId:policy.id,ruleVersion:policy.version,includeSimulation:true};
    const query=async(who=p)=>{
      const qualification=await post(p,'/v2/qualification/evaluate',input),honor=await post(who,'/v2/honor/query',honorInput);
      assert.equal(qualification.state,'insufficient-evidence');assert.equal(honor.card.acceptedCases,0,'synthetic fixtures never award actual Honor');
      return {qualification,honor};
    };
    const write=async(who,event,viewers=[])=>{const signed=await cg(who,event,viewers);await post(who,'/v2/cases/events',signed);return signed;};
    const original=(await f.db.query('SELECT id,payload_text,payload_hash FROM case_events WHERE id=$1',[work.result.eventId])).rows[0];
    const unchanged=async()=>assert.deepEqual((await f.db.query('SELECT id,payload_text,payload_hash FROM case_events WHERE id=$1',[work.result.eventId])).rows[0],original);
    const erase=async(event)=>{
      const get=async()=>(await f.db.query('SELECT id,case_id,subject_id,kind,version,consent_id,payload_hash,created_at FROM case_events WHERE id=$1',[event.eventId])).rows[0];
      const before=await get();await f.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1",[event.eventId]);assert.deepEqual(await get(),before);
    };
    const close=async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();};
    return{f,p,work,post,query,write,erase,unchanged,close};
  }catch(error){if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await f.db.close();throw error;}
}
const correction=(h,extra={})=>({...h.work.result,eventId:randomUUID(),expectedVersion:4,supersedes:{id:h.work.result.eventId,version:1},summary:'PRIVATE retained correction',...extra});
function support(view,expected){
  assert.equal(view.qualification.simulation.state,expected?'satisfied':'insufficient-evidence');
  assert.equal(view.honor.simulation.distinctCases,expected?1:0);
}

test('Qualification and Honor never revive accepted Result after private, revoked and body-erased correction; new accepted current Result restores support',async()=>{
  const h=await setup();try{
    const {f,p,work}=h;support(await h.query(),true);
    const revised=correction(h),signed=await h.write(p,revised);
    support(await h.query(),false);
    await f.consents.revoke(p.actor,signed.consentId);support(await h.query(),false);
    await h.erase(revised);const erased=await h.query();support(erased,false);
    assert.equal(erased.honor.items[0].sourceStatus,'fact_currentness_unavailable');
    for(const privateValue of [revised.eventId,revised.summary])assert.equal(JSON.stringify(erased).includes(privateValue),false);
    // A new result is explicit work; its Case sequence follows the retained
    // unknown row. A fresh delivery and requester acceptance are also required.
    const current=correction(h,{expectedVersion:5,supersedes:null,summary:'New explicit independent Result'});
    await h.write(p,current,[f.actor.subjectId]);support(await h.query(),false);
    const delivery={...work.delivery,eventId:randomUUID(),expectedParticipationVersion:4,resultRef:{id:current.eventId,version:1},summary:'Fresh exact current delivery'};
    await f.assistance.submitParticipationEvent(p.actor,work.proposal.participationId,await ag(p,delivery,[f.actor.subjectId]));
    await f.assistance.submitParticipationEvent(f.actor,work.proposal.participationId,await ag(f,{eventId:randomUUID(),kind:'accept',expectedParticipationVersion:5,deliveryId:delivery.eventId,summary:'Accept new exact Result'},[p.actor.subjectId]));
    support(await h.query(),true);await h.unchanged();
  }finally{await h.close();}
});

test('Retained Result uncertainty is scoped to the same Case and author; readable unrelated Result does not invalidate accepted work',async()=>{
  const h=await setup();try{
    const {f,p,work}=h;
    const ownerIntervention=(await f.db.query("SELECT id FROM case_events WHERE case_id=$1 AND subject_id=$2 AND kind='intervention'",[work.cid,f.actor.subjectId])).rows[0];
    const other={...work.result,eventId:randomUUID(),expectedVersion:4,actorId:f.actor.subjectId,origin:{kind:'intervention',id:ownerIntervention.id,version:1}};
    delete other.participationId;await h.write(f,other,[p.actor.subjectId]);await h.erase(other);support(await h.query(),true);
    const otherWork=await nativeWork(f,p);
    const otherCase={...otherWork.result,eventId:randomUUID(),expectedVersion:4,supersedes:{id:otherWork.result.eventId,version:1},summary:'Unrelated other Case correction'};
    await h.write(p,otherCase);await h.erase(otherCase);support(await h.query(),true);
    const unrelated={...work.result,eventId:randomUUID(),expectedVersion:5,summary:'Readable independent Result of same author'};
    await h.write(p,unrelated,[f.actor.subjectId]);support(await h.query(),true);
    // With no body the server cannot know which Result was changed. It must
    // express unavailable support, rather than guess the hidden relationship.
    await h.erase(unrelated);support(await h.query(),false);await h.unchanged();
  }finally{await h.close();}
});

test('Public selected-field Honor uses the same retained-source guard without exposing correction identity or original text',async()=>{
  const h=await setup();try{
    const {f,p,work}=h;
    const caseRows=(await f.db.query('SELECT * FROM case_events WHERE case_id=$1',[work.cid])).rows;
    const taskRows=(await f.db.query('SELECT * FROM task_events WHERE task_id=$1',[work.open.taskId])).rows;
    for(const who of [f,p]){
      const sourceRefs=[...caseRows.filter(r=>r.subject_id===who.actor.subjectId).map(r=>({kind:'case-event',id:r.id,eventVersion:1,payloadHash:r.payload_hash,fields:['eventType','actorId']})),...taskRows.filter(r=>r.subject_id===who.actor.subjectId).map(r=>({kind:'task-event',id:r.id,eventVersion:1,payloadHash:r.payload_hash,fields:['eventType','actorId']}))];
      const publication={id:randomUUID(),kind:'publish',purpose:'public-contribution-projections-only',purposes:['honor'],sourceRefs,expiresAt:new Date((f.now+500)*1000).toISOString(),redactionConfirmed:true,publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
      await h.post(who,'/v2/contributions/publish',await who.authorize(publication,'contribution.publish',{objectId:publication.id,visibility:'Public',purpose:'public-profile'}));
    }
    support(await h.query(null),true);
    const revised=correction(h);await h.write(p,revised);support(await h.query(null),false);
    await h.erase(revised);const view=await h.query(null);support(view,false);
    for(const hidden of [revised.eventId,revised.summary,work.result.summary,work.cid,work.open.taskId])assert.equal(JSON.stringify(view.honor).includes(hidden),false);
    assert.equal(view.honor.card.capabilityVerified,false);assert.equal(view.honor.card.qualificationGranted,false);await h.unchanged();
  }finally{await h.close();}
});
