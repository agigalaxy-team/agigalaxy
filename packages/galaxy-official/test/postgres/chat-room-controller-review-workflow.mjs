import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from '../service-fixture.mjs';
import {oidcProviderFixture} from '../oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from '../../src/oidc-login.mjs';
import {createApi} from '../../src/http.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),8000);})]);}finally{clearTimeout(timer);}}

// A-owned independent review driver. C supplies an isolated real PostgreSQL
// LOGIN inheriting galaxy_api and the separate fixture/observation admin pool.
// No controller resolver is replaced, no product source is changed, and no
// credential, identity payload or private account identifier is returned.
export async function verifyChatRoomControllerConcurrency(runtimePool,{adminDatabase,repositories,migrateDatabase=false}={}){
  assert.ok(adminDatabase,'An explicit isolated administrative observation pool is required');
  assert.equal(migrateDatabase,false,'The caller provisions migrations and roles before this review');
  const role=(await runtimePool.query("SELECT pg_has_role(current_user,'galaxy_api','MEMBER') AS inherits_api,r.rolsuper FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
  assert.equal(role?.inherits_api,true);assert.equal(role.rolsuper,false,'The runtime role must not be a superuser');
  const snapshotRead=deferred(),continueVote=deferred();let armed=false,mappingReads=0,votePid=null,unlinkPid=null;
  const memberIds=new Set();
  const wrappedPool={query:(...args)=>runtimePool.query(...args),async connect(){
    const connection=await runtimePool.connect();const pid=(await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return{release:error=>connection.release(error),async query(sql,...args){
      const text=typeof sql==='string'?sql:sql.text;
      if(armed&&text.includes('FROM external_identity_links')&&text.includes('FOR UPDATE'))unlinkPid=pid;
      const result=await connection.query(sql,...args);
      if(armed&&text.includes('FROM community_accounts a')&&text.includes('community_account_links')&&memberIds.has(args[0]?.[0])){
        votePid=pid;mappingReads++;
        if(mappingReads===memberIds.size){snapshotRead.resolve();await bounded(continueVote.promise,'Held current-party metadata snapshot');}
      }
      return result;
    }};
  }};
  const endpoint='https://official.example.org',now=Math.floor(Date.now()/1000);
  const issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
  let server,votePromise,unlinkPromise;
  try{
    const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic controller concurrency OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',
      redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
    const options={migrateDatabase:false,repositories,now,identityProviders:[provider],syntheticCommunityQuota:false};
    const people=[];for(let index=0;index<3;index++)people.push(await serviceFixture(['binding'],wrappedPool,options));
    const[a,b,c]=people;for(const person of people)memberIds.add(person.actor.subjectId);
    server=createApi({...a,rateLimit:1000});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    const post=async(who,path,input={})=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+who.credential},body:JSON.stringify(input)});
      const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
    const login=async(who,account)=>{
      issuer.setAccount(account);const started=await post(who,'/v1/identity/begin',{providerId:'fixture'}),callback=await issuer.authorize(started.authorizationUrl);
      const response=await fetch(origin+callback.pathname+callback.search);assert.equal(response.status,200);assert.equal((await response.json()).state,'awaiting-local-signature');
      const pending=await post(who,'/v1/identity/status',{id:started.loginId});
      await post(who,'/v1/identity/confirm',{id:started.loginId,signed:await who.signForTest(pending.payloadJson,'galaxy-identity-link+jws')});return started.loginId;
    };
    const sharedAccount='synthetic-shared-'+randomUUID();await login(a,sharedAccount);const bLink=await login(b,sharedAccount);await login(c,'synthetic-independent-'+randomUUID());
    const chat=a.chat,roomId=randomUUID();await chat.create(a.actor,{roomId,operationId:randomUUID(),title:'Independent PostgreSQL current-controller review'});
    for(const person of[b,c]){
      const view=await chat.get(a.actor,roomId),decisionId=randomUUID();
      const decision=await chat.proposeDecision(a.actor,roomId,{decisionId,expectedRevision:view.revision,action:'invite',targetSubjectId:person.actor.subjectId});
      assert.equal(decision.state,'approved');await chat.acceptInvite(person.actor,roomId,{decisionId});
    }
    const before=await chat.get(a.actor,roomId);assert.equal(before.members.length,3);assert.equal(before.independentMemberCount,2);
    const decisionId=randomUUID(),proposal=await chat.proposeDecision(a.actor,roomId,{decisionId,expectedRevision:before.revision,action:'join-rule',joinRule:{mode:'open',expiresAt:now+120}});
    assert.equal(proposal.state,'pending');assert.equal(proposal.requiredPartyCount,2);
    armed=true;
    votePromise=chat.voteDecision(c.actor,roomId,{decisionId,choice:'approve'}).then(value=>({state:value.state}),error=>({error:error.code??error.message}));
    await bounded(snapshotRead.promise,'Three real resolver metadata reads');
    let unlinkDone=false,unlinkError=null;
    unlinkPromise=b.identity.revoke(b.actor,{id:bLink}).then(value=>{unlinkDone=true;return value;},error=>{unlinkDone=true;unlinkError=error;return null;});
    let observedLock=false;
    const observationDeadline=Date.now()+4000;
    while(!unlinkDone&&Date.now()<observationDeadline){
      if(unlinkPid){const activity=(await adminDatabase.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[unlinkPid])).rows[0];
        if(activity?.wait_event_type==='Lock'){observedLock=true;break;}}
      await delay(25);
    }
    assert.ok(unlinkDone||observedLock,'The unlink must commit or visibly wait on a real PostgreSQL lock');
    if(unlinkError)throw unlinkError;
    const unlinkCommittedBeforeFinalVote=unlinkDone;
    continueVote.resolve();const vote=await bounded(votePromise,'Original final governance vote');
    await bounded(unlinkPromise,'Original unlink completion');if(unlinkError)throw unlinkError;
    armed=false;
    const after=await chat.get(a.actor,roomId);
    assert.equal(after.independentMemberCount,3,'The same subject becomes an independent party after its real association is unlinked');
    const original=(await adminDatabase.query('SELECT state,member_revision FROM chat_decisions WHERE decision_id=$1',[decisionId])).rows[0];
    assert.ok(votePid&&unlinkPid&&votePid!==unlinkPid,'The governance and unlink use distinct real runtime connections');
    assert.deepEqual(issuer.failures,[]);
    const staleGovernanceApplied=unlinkCommittedBeforeFinalVote&&original.state==='accepted'&&after.joinRule.mode==='open';
    return{event:'chat_current_controller_postgres_review',realPostgres:true,restrictedRuntimeLogin:true,realOidcAndSignedAssociation:true,
      separateRuntimeConnections:true,controllerResolver:'official-communityAccounts.resolveWithin',mappingReads,
      originalIndependentPartyCount:before.independentMemberCount,currentIndependentPartyCount:after.independentMemberCount,
      originalMemberRevision:proposal.memberRevision,currentProjectedMemberRevision:after.memberRevision,
      unlinkCommittedBeforeFinalVote,unlinkWaitedOnDatabaseLock:observedLock,originalVote:vote,originalDecisionState:original.state,
      currentRuleMode:after.joinRule.mode,staleGovernanceApplied,authorizationSnapshotPreserved:!staleGovernanceApplied,
      transport:'unused-no-MAM',productionAccountsUsed:false,callerPoolsClosed:false};
  }finally{
    armed=false;continueVote.resolve();if(votePromise||unlinkPromise)await Promise.allSettled([votePromise,unlinkPromise].filter(Boolean).map(value=>Promise.resolve(value)));
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await issuer.close();
  }
}
