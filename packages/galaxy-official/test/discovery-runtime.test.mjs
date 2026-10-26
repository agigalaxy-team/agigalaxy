import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {discoveryEvent,discoveryDeliveryTargets} from '../src/discovery-runtime/purpose.mjs';
import {DiscoveryRuntime,DiscoveryWorker} from '../src/discovery-runtime/runtime.mjs';
import {DiscoveryStore} from '../src/discovery-runtime/store.mjs';
import {discoveryRuntimeMigrationSql} from '../src/discovery-runtime/schema.mjs';
import {OpenPanelClient,GorseClient,MeilisearchClient} from '../src/discovery-runtime/native-clients.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {createDiscoveryReadOnlySource} from '../src/discovery-runtime/public-content-source.mjs';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {createDiscoveryClient} from '../../galaxy-web/src/features/discovery/client.mjs';
import {createDiscoveryHttp} from '../src/discovery-runtime/http.mjs';

test('discovery purpose boundary separates site analysis from qualified public recommendation actions',()=>{
 const page=discoveryEvent({eventId:randomUUID(),name:'pageview',pageKey:'account'});
 assert.equal(page.purpose,'site-usage-analytics');assert.deepEqual(discoveryDeliveryTargets(page),['openpanel']);
 const event=discoveryEvent({eventId:randomUUID(),name:'content-view',pageKey:'community',content:{kind:'post',id:randomUUID(),version:randomUUID()}});
 assert.deepEqual(discoveryDeliveryTargets({...event,itemKey:'post_'+event.content.id}),['openpanel','gorse']);
 for(const extra of [{pageKey:'private-chat'},{body:'private source'},{url:'https://outside.invalid/'},{accountId:randomUUID()},{mailId:randomUUID()},{caseId:randomUUID()}])assert.throws(()=>discoveryEvent({eventId:randomUUID(),name:'pageview',pageKey:'account',...extra}),{code:'invalid_discovery_request'});
 assert.throws(()=>discoveryEvent({eventId:randomUUID(),name:'content-view',pageKey:'account',content:event.content}),{code:'discovery_purpose_denied'});
 assert.deepEqual(discoveryDeliveryTargets({...event,name:'content-exposure',recommendationPurpose:undefined,itemKey:'post_'+event.content.id}),['openpanel']);
});

test('search and recommendation candidates never bypass current source or negative preference checks',async()=>{
 const valid=randomUUID(),stale=randomUUID(),privateId=randomUUID(),negative=randomUUID(),queued=[];
 const doc=id=>({id:'post_'+id,kind:'post',sourceId:id,version:randomUUID(),indexVersion:'current-'+id,title:'当前中文讨论',body:'实际当前正文',publishedUntil:9999999999,topic:'technology'});
 const documents=new Map([[valid,doc(valid)],[stale,doc(stale)],[negative,doc(negative)]]);
 const source={load:async ref=>documents.get(ref.id)??null,view:value=>({id:value.sourceId,title:value.title})};
 const runtime=new DiscoveryRuntime({endpoint:'https://galaxy.example.invalid',source,store:{enqueue:async value=>queued.push(value),excluded:async()=>new Set(['post_'+negative])},
  meili:{search:async()=>({hits:[{id:'post_'+privateId,version:'old'},{id:'post_'+stale,version:'stale'},{id:'post_'+valid,version:documents.get(valid).indexVersion}]})},
  gorse:{recommend:async()=>[{id:'post_'+privateId,source:'gorse-recommendation'},{id:'post_'+negative,source:'gorse-recommendation'},{id:'post_'+valid,source:'gorse-recommendation'}]}});
 const found=await runtime.search({query:'中文'});assert.deepEqual(found.items.map(item=>item.id),[valid]);assert.equal(JSON.stringify(found).includes('old'),false);assert.equal(queued.length,2);
 const recommendation=await runtime.recommend(null,randomUUID(),{});assert.deepEqual(recommendation.items.map(item=>item.id),[valid]);assert.equal(recommendation.items[0].reason.code,'recommendation-candidate');
 const selected=await runtime.searchSelected({query:'中文'},[{kind:'post',id:valid}]);assert.deepEqual(selected.items.map(item=>item.id),[valid]);
 const elsewhere=await runtime.searchSelected({query:'中文'},[{kind:'post',id:privateId}]);assert.deepEqual(elsewhere.items,[]);
 await assert.rejects(runtime.searchSelected({query:'中文'},[]),{code:'discovery_selected_scope_required'});
});

test('read-only worker source constructs original anonymous forum readers without API graph or row-write grants',async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites});
 async function publish(audience){const value=await bindForumIds('create-post','account:'+f.people[0].accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:f.people[0].accountId,title:'真实原reader中文夹具',body:'只给匿名公开资格索引',links:[],topic:'technology',audience,publishedUntil:f.now()+3600});await forum.publish(f.people[0],{payloadJson:JSON.stringify(value)});return value;}
 const publicPost=await publish({read:{kind:'everyone'},participate:{kind:'accounts'}}),privatePost=await publish({read:{kind:'accounts'},participate:{kind:'accounts'}});
 const queries=[],wrap=db=>({query:(sql,params)=>{queries.push(sql);return db.query(sql,params);}}),db={...wrap(f.db),transaction:operation=>f.db.transaction(tx=>operation(wrap(tx)))};
 const source=createDiscoveryReadOnlySource({db,endpoint:f.endpoint,now:f.now,readGrant:()=>{throw Error('anonymous source must not issue a consent');},forumPolicy:forum.policy,moderatorIds:[],identityProviders:[{issuer:'https://login.example.org',clientId:'synthetic-chat'}]});
 const value=await source.load({kind:'post',id:publicPost.postId});assert.equal(value.title,publicPost.title);assert.equal(value.version,publicPost.versionId);assert.equal(typeof value.indexVersion,'string');
 assert.equal(await source.load({kind:'post',id:privatePost.postId}),null);assert.ok(source.forum.governance);assert.deepEqual(Object.keys(source.forum.access).sort(),['db','endpoint','now']);assert.equal(queries.some(sql=>/FOR (SHARE|UPDATE)/.test(sql)),false);
 f.advance(3601);assert.equal(await source.load({kind:'post',id:publicPost.postId}),null);
});

test('concurrent mounted collectors share one visitor handshake and anonymous search does not rotate that cookie',async()=>{
 const endpoint='https://official.example.invalid',websiteOrigin='https://galaxy.example.invalid';let handshakes=0,ready=false,accepted=0;
 const fetcher=async(url,options)=>{
  const path=new URL(url).pathname;
  if(path==='/v1/account/session')return Response.json({state:'signed-out',galaxyAuthorization:false});
  if(path==='/v1/discovery/config'){handshakes++;await new Promise(resolve=>setTimeout(resolve,5));ready=true;return Response.json({csrfToken:'signed-visitor-token'});}
  assert.equal(ready,true,'cookie initialization must finish before either identity-dependent call');
  if(path==='/v1/discovery/events'){assert.equal(options.headers['X-Galaxy-Discovery-CSRF'],'signed-visitor-token');accepted++;return Response.json({accepted:true});}
  assert.equal(path,'/v1/discovery/recommendations');return Response.json({items:[]});
 };
 const first=createDiscoveryClient({endpoint,websiteOrigin,fetcher}),second=createDiscoveryClient({endpoint,websiteOrigin,fetcher});
 await Promise.all([first.record({name:'pageview',pageKey:'home'}),second.recommendations()]);assert.equal(handshakes,1);assert.equal(accepted,1);
 const headers=new Map(),adapter=createDiscoveryHttp({websiteOrigin,visitorSecret:'s'.repeat(40)});let found;
 const response={setHeader:(key,value)=>headers.set(key,value),getHeader:key=>headers.get(key)};
 await adapter.dispatch({discovery:{},request:{method:'GET',headers:{}},response,url:new URL(endpoint+'/v1/discovery/config'),send:()=>{}});
 const visitorCookie=headers.get('Set-Cookie')[0].split(';')[0];headers.clear();
 await adapter.dispatch({discovery:{search:async()=>({items:[]})},request:{method:'GET',headers:{cookie:visitorCookie}},response,url:new URL(endpoint+'/v1/discovery/search?q=中文'),send:(_status,value)=>{found=value;}});
 assert.deepEqual(found,{items:[]});assert.equal(headers.has('Set-Cookie'),false);
});

test('native client contracts use public OpenPanel REST, explicit credentials, idempotent Gorse PUT and native Meili tasks',async()=>{
 const requests=[],key='x'.repeat(40),id=randomUUID(),projectId=randomUUID();
 const transport=async(url,options)=>{requests.push({url,options,body:options.body?JSON.parse(options.body):null});if(url.includes('/tasks/'))return Response.json({status:'succeeded'});if(url.endsWith('/documents'))return Response.json({taskUid:1});return Response.json({ok:true});};
 const panel=new OpenPanelClient({url:'http://localhost:18001',clientId:id,clientSecret:key,readClientId:randomUUID(),readClientSecret:key,projectId,fetch:transport});
 await panel.track({eventId:id,name:'pageview',pageKey:'account',visitorId:id,profileId:'account:'+id,occurredAt:new Date().toISOString()});
 assert.equal(requests[0].body.payload.name,'screen_view');assert.equal(requests[0].body.payload.properties.__path,'/app/account');assert.equal(requests[0].body.payload.properties.purpose,'site-usage-analytics');assert.equal(JSON.stringify(requests[0].body).includes(key),false);
 await panel.tool('get_retention_cohort');assert.equal(new URL(requests.at(-1).url).pathname,'/insights/'+projectId+'/retention/cohort');
 const gorse=new GorseClient({url:'http://localhost:18088',apiKey:key,fetch:transport});await gorse.feedback({name:'content-view',profileId:'account:'+id,itemKey:'post_'+id,occurredAt:new Date().toISOString()});assert.equal(requests.at(-1).options.method,'PUT');assert.equal(requests.at(-1).body[0].FeedbackType,'view');
 const meili=new MeilisearchClient({url:'http://localhost:17700',apiKey:key,fetch:transport});await meili.upsert({id:'post_'+id,title:'中文检索'});assert.match(requests.at(-1).url,/\/tasks\/1$/);
 assert.throws(()=>new GorseClient({url:'http://localhost:18088',apiKey:''}));
 const broken=new MeilisearchClient({url:'http://localhost:17700',apiKey:key,fetch:async()=>new Response('secret response '+key,{status:500})});await assert.rejects(broken.search({query:'x',after:0,limit:1}),error=>error.code==='discovery_engine_failed'&&!error.message.includes(key));
});

test('migration and outbox preserve cross-lease unknown analytics delivery and current-source invalidation',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE community_accounts(id uuid PRIMARY KEY,endpoint text);
 CREATE TABLE forum_posts_v1(id uuid PRIMARY KEY);CREATE TABLE forum_versions_v1(id uuid PRIMARY KEY,post_id uuid);CREATE TABLE forum_replies_v1(id uuid PRIMARY KEY,post_id uuid);
 CREATE TABLE forum_permissions_v1(id uuid);CREATE TABLE forum_sections_v2(id uuid);CREATE TABLE forum_governance_events_v1(id uuid);CREATE TABLE operations_content_visibility_v1(id uuid);CREATE TABLE operations_forum_curation_v1(id uuid);CREATE TABLE operations_forum_tags_v1(id uuid);CREATE TABLE bindings(id uuid);CREATE TABLE consents(id uuid);CREATE TABLE deletion_requests(id uuid);`);
 await db.exec(discoveryRuntimeMigrationSql);let clock=Math.floor(Date.now()/1000)+1;const now=()=>clock,endpoint='https://galaxy.example.invalid',store=new DiscoveryStore({db,endpoint,now});await store.initialize();
 const id=randomUUID();await db.query('INSERT INTO forum_posts_v1(id) VALUES($1)',[id]);assert.equal((await db.query('SELECT count(*)::int n FROM discovery_index_outbox_v1')).rows[0].n,1);
 const generation=(await db.query('SELECT generation FROM discovery_index_outbox_v1')).rows[0].generation;await db.exec('UPDATE forum_sections_v2 SET id=id');assert.notEqual((await db.query('SELECT generation FROM discovery_index_outbox_v1')).rows[0].generation,generation);
 const event={...discoveryEvent({eventId:randomUUID(),name:'pageview',pageKey:'home'}),accountId:null,visitorId:randomUUID(),profileId:'visitor:'+randomUUID(),occurredAt:new Date(clock*1000).toISOString()};
 await store.record(event);assert.equal((await store.record({...event,occurredAt:new Date((clock+1)*1000).toISOString()})).replayed,true);
 assert.deepEqual((await db.query('SELECT target FROM discovery_delivery_outbox_v1')).rows.map(row=>row.target),['openpanel']);
 let sends=0,observes=0;const runtime=new DiscoveryRuntime({db,endpoint,store,source:{load:async()=>null},openpanel:{track:async()=>{sends++;throw new ServiceError('discovery_engine_unavailable',503);},eventObserved:async()=>{observes++;return false;}}}),worker=new DiscoveryWorker(runtime);
 assert.equal((await worker.deliverOne()).state,'failed');clock+=400;assert.equal((await worker.deliverOne()).state,'result-unknown');assert.equal(sends,1);assert.equal(observes,1);
 const row=await store.claim('discovery_delivery_outbox_v1');assert.equal(row,null);clock+=400;const lease=await store.claim('discovery_delivery_outbox_v1');assert.equal(lease.submission_started,true);clock+=61;await worker.deliverOne();assert.equal(sends,1);assert.equal(observes,2);
});
