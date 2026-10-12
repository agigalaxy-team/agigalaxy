import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {defaultForumPolicy} from '../src/community-forum-policy-v1.mjs';
import {forumTopics} from '../src/shared/community-forum-topics-v1.mjs';
import {forumCreatePostSchema} from '../src/shared/community-forum-v1-schema.mjs';
import {digest} from '../src/shared/digest.mjs';
import {PGlite} from '@electric-sql/pglite';
import {migrations} from '../src/infrastructure/migrations.mjs';
import {migrate} from '../src/database.mjs';
import {serviceFixture} from './service-fixture.mjs';

const policy={...defaultForumPolicy,new:{...defaultForumPolicy.new,post:60},normal:{...defaultForumPolicy.normal,post:60}};
async function allPages(f,path,input={},options={}){
 const items=[],cursors=new Set();let after;
 do{
  const page=await f.ok(path,{...options,input:{...input,...(after?{after}:{})}});
  items.push(...page.items);after=page.nextAfter;
  if(after){assert.equal(cursors.has(after),false,'cursor progresses');cursors.add(after);}
 }while(after);
 return items;
}
const publicOptions={authorization:false};

test('real signed HTTP/OIDC: topics, complete title/body search and first-publication keyset pages',async()=>{
 const f=await communityForumFixture({policy});try{
  await f.login(f.owner,'topic-pages-owner');
  const catalog=await f.ok('/v2/community/topics',publicOptions);assert.deepEqual(catalog.items,forumTopics);assert.equal(catalog.unclassified.id,'unclassified');
  const posts=[];
  for(let index=0;index<13;index++){
   const p=await f.post({title:'Distinct publication '+index,body:index===0?'The older body contains deep-needle.':'Readable ordinary text '+index,
    ...(index===12?{}:{topic:index<10?'technology':'life'})});
   const written=await f.write(f.owner,'create-post',p);assert.equal(written.status,200,JSON.stringify(written.body));posts.push(p);f.clock.now++;
  }
  const collected=await allPages(f,'/v2/community/posts/query',{order:'published',limit:3},publicOptions);
  assert.deepEqual(collected.map(item=>item.locator.postId),posts.toReversed().map(item=>item.postId));assert.equal(new Set(collected.map(item=>item.locator.postId)).size,13);
  const tech=await allPages(f,'/v2/community/posts/query',{topic:'technology',order:'published',limit:3},publicOptions);
  assert.deepEqual(tech.map(item=>item.locator.postId),posts.slice(0,10).toReversed().map(item=>item.postId));
  const first=await f.ok('/v2/community/posts/query',{input:{topic:'technology',order:'published',limit:3},...publicOptions});
  assert.equal(first.items.some(item=>item.locator.postId===posts[0].postId),false);
  const search=await f.ok('/v2/community/posts/query',{input:{topic:'technology',query:'DEEP-NEEDLE',order:'published'},...publicOptions});
  assert.deepEqual(search.items.map(item=>item.locator.postId),[posts[0].postId]);
  const titleSearch=await f.ok('/v2/community/posts/query',{input:{query:'Distinct publication 11',order:'published'},...publicOptions});assert.equal(titleSearch.items[0].locator.postId,posts[11].postId);
  const legacy=await f.ok('/v2/community/posts/query',{input:{topic:'unclassified',order:'published'},...publicOptions});assert.equal(legacy.items.length,1);assert.equal(legacy.items[0].topic,'unclassified');assert.equal(Object.hasOwn(legacy.items[0].payload,'topic'),false);
  assert.equal((await f.db.query('SELECT topic FROM forum_versions_v1 WHERE id=$1',[posts[12].versionId])).rows[0].topic,null);
  const owner=await allPages(f,'/v2/community/posts/owned',{order:'published',limit:4});assert.equal(owner[0].payload.title,posts[12].title);assert.equal(owner[0].createdAt,collected[0].createdAt);
  for(const input of [{topic:'life',query:'',order:'published',after:first.nextAfter},{topic:'technology',query:'changed',order:'published',after:first.nextAfter},{order:'id',after:first.nextAfter}]){
   const result=await f.request('/v2/community/posts/query',{input,...publicOptions});assert.equal(result.status,400);assert.equal(result.body.error,'forum_cursor_mismatch');
  }
  const wrongOwner=await f.request('/v2/community/posts/owned',{input:{topic:'technology',order:'published',after:first.nextAfter}});assert.equal(wrongOwner.body.error,'forum_cursor_mismatch');
  const byId=await allPages(f,'/v2/community/posts/query',{order:'id',limit:4},publicOptions);
  const expectedIds=posts.map(item=>item.postId).sort((left,right)=>left<right?-1:left>right?1:0);assert.deepEqual(byId.map(item=>item.locator.postId),expectedIds);
  const compatibility=await f.ok('/v2/community/posts/query',{input:{after:expectedIds[3],limit:4},...publicOptions});assert.equal(compatibility.order,'id');assert.deepEqual(compatibility.items.map(item=>item.locator.postId),expectedIds.slice(4,8));
  assert.equal((await f.request('/v2/community/posts/query',{input:{after:expectedIds[3],order:'published'},...publicOptions})).body.error,'forum_cursor_mismatch');
 }finally{await f.close();}
});

test('same-second publications are stable; new topic version never changes original payload/hash/time',async()=>{
 const f=await communityForumFixture({policy});try{
  await f.login(f.owner,'topic-version-owner');await f.login(f.responder,'topic-version-reply');const at=f.clock.now,posts=[],signed=[];
  for(let index=0;index<5;index++){const p=await f.post({topic:'technology',title:'Simultaneous '+index});const written=await f.write(f.owner,'create-post',p);assert.equal(written.status,200);posts.push(p);signed.push(written.input);}
  const pages=await allPages(f,'/v2/community/posts/query',{order:'published',limit:2},publicOptions);
  assert.deepEqual(pages.map(item=>item.locator.postId),posts.map(item=>item.postId).sort((left,right)=>left>right?-1:left<right?1:0));assert.ok(pages.every(item=>item.createdAt===at));
  const p=posts[0],before=(await f.db.query('SELECT payload_text,payload_hash FROM forum_events_v1 WHERE id=$1',[p.operationId])).rows[0];f.clock.now+=10;
  const newer=await f.post({postId:p.postId,expectedHeadVersion:1,title:'Later arts version',topic:'arts'});assert.equal((await f.write(f.owner,'publish-version',newer)).status,200);
  const old=await f.ok(`/v2/community/posts/${p.postId}/versions/${p.versionId}`,publicOptions),current=await f.ok(`/v2/community/posts/${p.postId}`,publicOptions);
  assert.deepEqual(old.payload,p);assert.equal(old.topic,'technology');assert.equal(current.topic,'arts');assert.equal(current.createdAt,at);assert.equal(current.versionCreatedAt,at+10);assert.equal(old.versionCreatedAt,at);
  assert.equal(current.updatedAt,at+10);assert.equal((await f.db.query('SELECT payload_text,payload_hash FROM forum_events_v1 WHERE id=$1',[p.operationId])).rows[0].payload_text,before.payload_text);
  assert.equal(before.payload_hash,digest(signed[0].payloadJson));assert.equal((await f.ok('/v2/community/posts/query',{input:{topic:'technology',order:'published'},...publicOptions})).items.some(item=>item.locator.postId===p.postId),false);
  f.clock.now+=5;const reply=await f.reply(p);assert.equal((await f.write(f.responder,'create-reply',reply)).status,200);
  assert.equal((await f.ok(`/v2/community/replies/${reply.replyId}`,publicOptions)).createdAt,at+15);
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,publicOptions)).createdAt,at);assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,publicOptions)).versionCreatedAt,at+10);
  assert.equal(forumCreatePostSchema.safeParse({...p,topic:'unclassified'}).success,false);
 }finally{await f.close();}
});

test('paging rechecks expiry/revocation/withdrawal and owned never returns unavailable cached title/body/topic',async()=>{
 const f=await communityForumFixture({policy});try{
  await f.login(f.owner,'topic-current-authorization');const start=f.clock.now;
  const expired=await f.post({topic:'technology',title:'Secret expired needle',publishedUntil:start+10}),revoked=await f.post({topic:'technology',title:'Secret revoked needle'}),withdrawn=await f.post({topic:'technology',title:'Secret withdrawn needle'}),visible=await f.post({topic:'technology',title:'Visible page'});
  for(const p of [expired,revoked,withdrawn,visible]){const written=await f.write(f.owner,'create-post',p);assert.equal(written.status,200);p.testConsent=written.consentId;f.clock.now++;}
  const first=await f.ok('/v2/community/posts/query',{input:{order:'published',limit:1},...publicOptions});assert.equal(first.items[0].locator.postId,visible.postId);
  await f.owner.consents.revoke(f.owner.actor,revoked.testConsent);
  assert.equal((await f.write(f.owner,'withdraw-post',{schemaVersion:1,operationId:randomUUID(),postId:withdrawn.postId,expectedHeadVersion:1})).status,200);
  f.clock.now=start+11;
  const next=await f.ok('/v2/community/posts/query',{input:{order:'published',after:first.nextAfter,limit:1},...publicOptions});assert.deepEqual(next.items,[]);assert.equal(next.nextAfter,null);
  const search=await f.ok('/v2/community/posts/query',{input:{query:'needle',order:'published'},...publicOptions});assert.deepEqual(search.items,[]);
  const owned=await f.ok('/v2/community/posts/owned',{input:{order:'published',limit:10}});assert.equal(owned.items.length,4);
  for(const item of owned.items.filter(value=>value.locator.postId!==visible.postId)){for(const field of ['payload','topic','versionCreatedAt','publishedUntil','permissionId'])assert.equal(Object.hasOwn(item,field),false,field+' unavailable');}
  assert.equal(JSON.stringify(owned).includes('Secret'),false);assert.equal(owned.items[0].payload.title,visible.title);
  const filtered=await f.ok('/v2/community/posts/owned',{input:{topic:'technology',query:'needle',order:'published'}});assert.deepEqual(filtered.items,[]);
 }finally{await f.close();}
});

test('actual schema81 -> 82/83 migration preserves old event JSON/hash, signed Consent, locators and publication times',async()=>{
 const db=new PGlite();try{
  await db.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const migration of migrations.filter(value=>value.version<=81)){await db.exec(migration.sql);await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);}
  const who=await serviceFixture(['binding','consent','assistance'],db,{migrateDatabase:false,syntheticCommunityQuota:false});
  const p={schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),expectedHeadVersion:0,versionId:randomUUID(),title:'Legacy migration sample',body:'Unchanged original JSON',links:[],publishedUntil:who.now+3600};
  const payloadJson=JSON.stringify(p),hash=digest(payloadJson),at=new Date(who.now*1000).toISOString(),intent={version:1,id:randomUUID(),subjectId:who.actor.subjectId,
   bindingId:who.actor.bindingId,endpoint:who.access.endpoint,objectId:p.versionId,action:'forum.post.publish',purpose:'public-profile',recipient:who.access.endpoint,
   fields:Object.keys(p),visibility:'Public',viewers:[],payloadHash:hash,policyVersion:'0.1',issuedAt:who.now,expiresAt:p.publishedUntil};
  const signedIntent=await who.signForTest(JSON.stringify(intent),'galaxy-consent+jws');
  // An isolated upgrade fixture represents stored pre82 facts. This SQL sample
  // is migration integrity evidence, never a normal posting/permission result.
  await who.access.runResourceWrite(who.actor,'assistance',{},async(tx,authorization)=>{
   await who.forum.consentWithin(tx,who.actor,authorization,signedIntent);
   await tx.query("INSERT INTO forum_posts_v1(id,subject_id,head_version,state,created_at,updated_at) VALUES($1,$2,1,'published',$3,$3)",[p.postId,who.actor.subjectId,at]);
   await tx.query("INSERT INTO forum_events_v1(id,subject_id,kind,post_id,version_id,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,'create-post',$3,$4,$5,$6,$7,$8)",[p.operationId,who.actor.subjectId,p.postId,p.versionId,intent.id,payloadJson,hash,at]);
   await tx.query("INSERT INTO forum_versions_v1(id,post_id,subject_id,version_number,publication_event_id,payload_hash,published_until,state,created_at) VALUES($1,$2,$3,1,$4,$5,$6,'published',$7)",[p.versionId,p.postId,who.actor.subjectId,p.operationId,hash,new Date(p.publishedUntil*1000).toISOString(),at]);
   await tx.query('UPDATE forum_posts_v1 SET current_version_id=$2 WHERE id=$1',[p.postId,p.versionId]);
  });
  const before={post:(await db.query('SELECT * FROM forum_posts_v1')).rows,event:(await db.query('SELECT * FROM forum_events_v1')).rows,version:(await db.query('SELECT * FROM forum_versions_v1')).rows,
   consent:(await db.query('SELECT * FROM consents WHERE id=$1',[intent.id])).rows};
  assert.equal(await migrate(db),83);
  assert.deepEqual((await db.query('SELECT * FROM forum_posts_v1')).rows,before.post);assert.deepEqual((await db.query('SELECT * FROM forum_events_v1')).rows,before.event);
  assert.equal(digest(JSON.stringify((await db.query('SELECT * FROM consents WHERE id=$1',[intent.id])).rows)),digest(JSON.stringify(before.consent)));
  const version=(await db.query('SELECT * FROM forum_versions_v1')).rows[0],{topic,...unchanged}=version;assert.equal(topic,null);assert.deepEqual(unchanged,before.version[0]);
  const indexes=(await db.query("SELECT indexname FROM pg_indexes WHERE indexname IN ('forum_posts_publication_v1','forum_posts_owner_publication_v1','forum_versions_topic_v1')")).rows;assert.equal(indexes.length,3);
 }finally{await db.close();}
});
