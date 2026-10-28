// Original resource-budget SQL/policy oracle and isolated PostgreSQL fixture.
// This never reads production connection settings or performs authentication.
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {generateKeyPairSync,randomUUID,createHash} from 'node:crypto';
import {loadResourceBudgetPolicy,subjectResourceUsage,enforceResourceGrowth,lockSubjectResourceBudget,resourceBudgetPolicySchema} from '../../packages/galaxy-official/src/infrastructure/resource-budgets.mjs';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {createGalaxyGenesis} from '../../packages/galaxy-core/src/galaxy-guid.mjs';
const mode=process.argv[2];
if(mode==='oracle'){
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));const queries=[];await subjectResourceUsage({query:async(q)=>{queries.push(q);return {rows:[queries.length===1?{bytes:'0'}:{count:'0'}]}}},'isolated-subject',2000000000);
 const outcomes=input.cases.map(c=>{try{enforceResourceGrowth({...c.before,payloadBytes:BigInt(c.before.payloadBytes)},{...c.after,payloadBytes:BigInt(c.after.payloadBytes)},c.policy);return null}catch(e){return e.code}});
 console.log(JSON.stringify({queries,defaultPolicy:await loadResourceBudgetPolicy(),validations:input.policies.map(p=>resourceBudgetPolicySchema.safeParse(p).success),outcomes}));
}else{
 const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(address.protocol!=='postgres:'||address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated PostgreSQL required');const db=new pg.Pool({connectionString:address.href,max:2});
 const now=()=>2000000000;
 try{
 if(mode==='setup'){
  await migrate(db,{roles:['api']});const at=new Date(now()*1000),pair=generateKeyPairSync('ed25519'),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'}),genesis=createGalaxyGenesis({publicKeyPem,originCode:'5',issuedAtMs:now()*1000});const subject=genesis.id,bindingId=randomUUID(),challengeId=randomUUID(),accountId=randomUUID(),scopeId=randomUUID(),credentialHash=createHash('sha256').update(randomUUID()).digest('hex'),installationId=randomUUID();
  await db.query('INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,$2,$3)',[subject,publicKeyPem,genesis.genesisProof]);
  await db.query('INSERT INTO binding_challenges(id,subject_id,payload,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)',[challengeId,subject,{installationId},createHash('sha256').update(challengeId).digest('hex'),new Date((now()+3600)*1000)]);
  await db.query('INSERT INTO bindings(id,subject_id,challenge_id,request_hash,audience,scopes,receipt,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[bindingId,subject,challengeId,createHash('sha256').update(bindingId).digest('hex'),'https://budget.example.invalid',JSON.stringify(['binding','consent']),'isolated budget ledger fixture',new Date((now()+3600)*1000)]);
  await db.query('INSERT INTO access_credentials(token_hash,binding_id,scopes,expires_at) VALUES($1,$2,$3,$4)',[credentialHash,bindingId,JSON.stringify(['binding']),new Date((now()+600)*1000)]);
  await db.query('INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[accountId,'https://budget.example.invalid','https://issuer.example.invalid',subject,'external-account',at]);
  await db.query('INSERT INTO account_work_scopes_v1(account_id,scope_id,work_id,origin_subject_id,created_at) VALUES($1,$2,$3,$4,$5)',[accountId,scopeId,'原工作',subject,at]);
  await db.query('INSERT INTO account_work_v1(account_id,work_id,origin_subject_id,scope_id,revision,state,upload_level,data,last_operation_id,created_at,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$9)',[accountId,'原工作',subject,scopeId,'stored','work-content',{title:'字节检查',body:'原有效内容'},randomUUID(),at]);
  for(const [state,owner] of [['pending',subject],['running',subject],['completed',subject],['pending','unrelated-subject']])await db.query('INSERT INTO jobs(id,kind,deduplication_key,payload,state) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'builder-probe',randomUUID(),{subjectId:owner},state]);
  for(const [expiry,revoked] of [[now()+600,null],[now()-1,null],[now()+600,at]])await db.query('INSERT INTO data_exports(id,subject_id,binding_id,datasets,bounds,selection_cutoff,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),subject,bindingId,'[]','{}',at,new Date(expiry*1000),revoked]);
  console.log(JSON.stringify({subjectId:subject,bindingId,credentialHash,accountId,scopeId,publicKeyPem}));
 }else if(mode==='usage'){
  const usage=await subjectResourceUsage(db,process.env.GALAXY_GO_TEST_BUDGET_SUBJECT,now());console.log(JSON.stringify({...usage,payloadBytes:usage.payloadBytes.toString()}));
 }else if(mode==='original-lock'){
  await db.query('BEGIN');try{await db.query("SET LOCAL lock_timeout='200ms'");await lockSubjectResourceBudget(db,process.env.GALAXY_GO_TEST_BUDGET_SUBJECT);console.log(JSON.stringify({locked:true}))}catch(e){if(e.code!=='55P03')throw e;console.log(JSON.stringify({blocked:true}))}finally{await db.query('ROLLBACK')}
 }else throw Error('fixture mode required');
 }finally{await db.end()}
}
