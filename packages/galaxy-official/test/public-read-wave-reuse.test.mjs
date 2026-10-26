import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate, transaction} from "../src/infrastructure/database.mjs";
import {AccessService} from "../src/security/access.mjs";
import {CommunityAccountRegistry} from "../src/accounts/community-accounts.mjs";
import {PublicWriteService} from "../src/publishing/public-writes.mjs";
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {CommunityForumGovernanceV1} from "../src/community/community-forum-governance-v1.mjs";
import {PublicCommunitySource} from '../src/discovery-runtime/public-content-source.mjs';
import {publicReadBatch} from '../src/discovery-runtime/public-read-batch.mjs';
import {typedPublicReadKey,typedPublicReadStatement} from '../src/discovery-runtime/public-read-templates.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';

test('one bounded source wave reuses identical fixed reads without changing native rows, clock bindings or qualification', {timeout:120000}, async t => {
  const db = new PGlite(); t.after(() => db.close());
  await migrate(db, {roles:['api','worker']});
  const endpoint='https://typed-source.example.org', now=()=>2_000_000_000;
  const access=new AccessService({db,endpoint,now,trustedKeys:new Map()});
  const accounts=new CommunityAccountRegistry(access,[{describe:()=>({issuer:'https://login.example.org',clientId:'owned-typed-check'})}]);
  const publicWrites=new PublicWriteService(access,accounts), forum=new CommunityForumV1(access,null,{accounts,publicWrites});
  new CommunityForumGovernanceV1(access,null,forum,{accounts,moderatorIds:[]});
  const people=Array.from({length:6},(_,i)=>({kind:'official-account',accountId:randomUUID(),endpoint,subject:'typed-owned-'+i}));
  await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
    SELECT id,$2,'https://login.example.org',subject,'external-account',$3,$3 FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,subject text)`,
    [JSON.stringify(people.map(p=>({id:p.accountId,subject:p.subject}))),endpoint,new Date(now()*1000)]);
  async function publish(index,publicRead=true) {
    const person=people[Math.floor(index/3)];
    const p=await bindForumIds('create-post','account:'+person.accountId,{schemaVersion:1,operationId:randomUUID(),accountId:person.accountId,postId:randomUUID(),expectedHeadVersion:0,versionId:randomUUID(),title:'真实固定读取 '+index,body:publicRead?'当前公开资格与原行类型核对。':'PRIVATE_TYPED_SOURCE',links:[],topic:'life',publishedUntil:now()+3600,audience:{read:{kind:publicRead?'everyone':'accounts'},participate:{kind:'everyone'}}});
    await forum.publish(person,{payloadJson:JSON.stringify(p)}); return p;
  }
  const posts=[]; for(let i=0;i<12;i++) posts.push(await publish(i));
  const privatePost=await publish(12,false), hiddenPost=await publish(13);
  const person=people[5], replies=[];
  for(let i=0;i<3;i++) {
    const p=await bindForumIds('create-reply','account:'+person.accountId,{schemaVersion:1,operationId:randomUUID(),accountId:person.accountId,replyId:randomUUID(),postId:posts[0].postId,postVersionId:posts[0].versionId,expectedRevision:0,body:'保持当前父许可 '+i,publishedUntil:now()+3600,replyTo:null,audience:{read:{kind:'everyone'},participate:{kind:'everyone'}}});
    await forum.createReply(person,{payloadJson:JSON.stringify(p)}); replies.push(p);
  }
  await db.query(`INSERT INTO operations_content_visibility_v1(endpoint,target_kind,target_id,revision,hidden_until,operation_id,updated_at) VALUES($1,'forum-post',$2,1,$3,$4,$5)`,[endpoint,hiddenPost.postId,new Date((now()+3600)*1000),randomUUID(),new Date(now()*1000)]);
  await db.query('SET ROLE galaxy_api');
  const original=new PublicCommunitySource({db,endpoint,forum,readOnly:true}), refs=await original.candidates({limit:100});
  const queries=new Map(), observe={query:async(sql,values=[])=>{
    if(typedPublicReadStatement(sql,[{values}])) { const list=queries.get(sql)??[];list.push(values);queries.set(sql,list); }
    return db.query(sql,values);
  }};
  const oracle=[];
  for(const ref of refs) { const doc=await original.load(ref,{db:observe}); if(doc)oracle.push(doc); }
  assert.equal(queries.size,14,'every actual fixed template must be exercised, not guessed from a substitute reader');
  const snapshot=await original.qualifiedSnapshot();
  assert.equal(snapshot.complete,true);assert.equal(snapshot.scanned,refs.length);assert.deepEqual(snapshot.documents,oracle);
  assert.equal(snapshot.documents.some(row=>[privatePost.postId,hiddenPost.postId].includes(row.sourceId)),false);
  assert.equal(JSON.stringify(snapshot.documents).includes('PRIVATE_TYPED_SOURCE'),false);
  assert.equal(snapshot.documents.filter(row=>row.kind==='reply').length,replies.length);
  let typedStatements=0, maxStatementBytes=0;
  await transaction(db,async tx=>{
    for(const [sql,seen] of queries) {
      const inputs=Array.from({length:35},(_,i)=>i===34?seen[0].map(()=>null):seen[i%seen.length]);
      const expected=[];for(const values of inputs)expected.push(await tx.query(sql,values));
      const batch=publicReadBatch({query:(text,values)=>{
        assert.match(text,/CROSS JOIN LATERAL/);typedStatements++;maxStatementBytes=Math.max(maxStatementBytes,Buffer.byteLength(text));
        return tx.query(text,values);
      }},{reuseKnownBindings:true});
      const actual=await Promise.all(inputs.map(values=>batch.query(sql,values)));
      for(let i=0;i<actual.length;i++) {
        assert.deepEqual(actual[i].rows,expected[i].rows);
        assert.equal(actual[i].rowCount,expected[i].rows.length);
        assert.deepEqual(actual[i].fields.map(f=>[f.name,f.dataTypeID]),expected[i].fields.map(f=>[f.name,f.dataTypeID]));
      }
      // Resolved and in-flight callers may inspect/mutate their own projection.
      // Replaying this binding must retain the independently read original row.
      if(actual[0].rows[0])actual[0].rows[0].id='changed-only-by-this-reader';
      actual[0].rows.length=0;
      assert.deepEqual((await batch.query(sql,inputs[0])).rows,expected[0].rows);
      const oldCount=typedStatements;
      const fresh=publicReadBatch({query:(text,values)=>{typedStatements++;return tx.query(text,values);}},{reuseKnownBindings:true});
      assert.deepEqual((await fresh.query(sql,inputs[0])).rows,expected[0].rows);
      assert.equal(typedStatements,oldCount+1,'next wave must make its own qualification read');
    }
    const fallbackSql='SELECT $1::bigint AS count,$2::timestamptz AS at,x FROM generate_series(1,3) x ORDER BY x DESC';
    const fallbackValues=['9223372036854775806',new Date(now()*1000)], expected=await tx.query(fallbackSql,fallbackValues);
    const fallback=publicReadBatch(tx);
    for(const actual of await Promise.all(Array.from({length:35},()=>fallback.query(fallbackSql,fallbackValues)))) assert.deepEqual(actual.rows,expected.rows);
    assert.deepEqual((await fallback.query("SELECT '$1'::text AS literal,$1::integer AS value",[7])).rows,[{literal:'$1',value:7}]);
  });
  assert.equal(typedStatements,28,'14 waves reuse duplicates and 14 fresh waves re-read the database');
  assert.ok(maxStatementBytes<12000);
  assert.equal(typedPublicReadStatement('SELECT $1::text AS arbitrary',[{values:['no dynamic type guessing']}]),null);
  const fixed='SELECT * FROM forum_posts_v1 WHERE id=$1';
  assert.throws(()=>typedPublicReadStatement(fixed,[{values:['not-a-uuid']}]),/template parameter invalid/);
  assert.throws(()=>typedPublicReadStatement(fixed,[{values:[randomUUID(),'extra']}]),/template parameter invalid/);
  const paged='SELECT id,version_number FROM forum_versions_v1 WHERE post_id=$1 AND version_number>$2 ORDER BY version_number LIMIT $3';
  assert.throws(()=>typedPublicReadStatement(paged,[{values:[randomUUID(),'0',3]}]),/template parameter invalid/);
  const reports=[...queries.keys()].find(sql=>sql.includes('restriction_until>$2')&&!sql.includes('LIMIT'));
  assert.throws(()=>typedPublicReadStatement(reports,[{values:['not-json',new Date()]}]),/template parameter invalid/);
  assert.throws(()=>typedPublicReadStatement(reports,[{values:['{}',new Date(NaN)]}]),/template parameter invalid/);
  const time=new Date(now()*1000),later=new Date((now()+1)*1000);
  assert.notEqual(typedPublicReadKey(reports,['{}',time]),typedPublicReadKey(reports,['{}',later]));
  assert.notEqual(typedPublicReadKey(reports,['{}',time]),typedPublicReadKey(reports,['{}',time.toISOString()]));
  assert.notEqual(typedPublicReadKey(reports,['{}',time]),typedPublicReadKey(reports,['{ }',time]));
  assert.equal(typedPublicReadKey('SELECT $1::text AS arbitrary',['not fixed']),null);
  assert.throws(()=>typedPublicReadKey(fixed,['not-a-uuid']),/template parameter invalid/);

  const failed=publicReadBatch({query:()=>assert.fail('invalid fixed parameters must fail before SQL')},{reuseKnownBindings:true});
  await assert.rejects(failed.query(fixed,['not-a-uuid']),/template parameter invalid/);
  t.diagnostic(JSON.stringify({fixedTemplates:queries.size,candidates:refs.length,qualified:oracle.length,typedStatements,maxStatementBytes,real:['PGlite API-role SQL','actual forum writes','original anonymous public-reader oracle'],nativeTypesAndOrderPreserved:true,privateAndHiddenExcluded:true,unknownTemplatesUseOriginalBoundedPath:true,productionRequests:0,nativeEngines:'not called'}));
});
