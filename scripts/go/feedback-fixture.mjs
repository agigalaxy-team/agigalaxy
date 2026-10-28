// Isolated interoperability fixture. Uses the current JS migrations and real
// feedback service; it refuses external hosts and non-test database names.
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {randomUUID} from 'node:crypto';
import canonicalize from '../../packages/galaxy-official/node_modules/canonicalize/lib/canonicalize.js';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {BusinessAdminService} from '../../packages/galaxy-official/src/operations/audit/service.mjs';
import {OperationsFeedbackService} from '../../packages/galaxy-official/src/operations/feedback/service.mjs';
import {feedbackSubmitSchema} from '../../packages/galaxy-official/src/shared/operations-feedback-schema.mjs';
import {attachOperationsFixtureAuthority} from '../../packages/galaxy-official/test/fixtures/operations-authority.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';

const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.protocol!=='postgres:'||address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const pool=new pg.Pool({connectionString:address.href,max:2}),endpoint='https://go-feedback.example.invalid',now=()=>2000000000;
try{
 if(process.argv[2]==='setup'){
  await migrate(pool);
  const accounts=[];
  for(const name of ['林澈','唐禾']){
   const id=randomUUID(),at=new Date(now()*1000).toISOString();
   await pool.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
    VALUES($1,$2,'https://login.example.invalid',$4,'external-account',$3,$3)`,[id,endpoint,at,id]);
   await pool.query(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,query_enabled,updated_at) VALUES($1,'person',$2,false,$3)`,[id,name,at]);
   accounts.push(id);
  }
  for(const [id,name]of [['go-admin','反馈处理员'],['go-reader','反馈观察员']])await pool.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
   VALUES($1,$2,'https://login.example.invalid',$1,$3,$4,$4)`,[id,endpoint,name,new Date(now()*1000)]);
  const submission={operationId:randomUUID(),body:'  搜索结果返回后，先前选择的分类未保留。\n请检查返回路径。  ',category:'problem',module:'discovery'};
  console.log(JSON.stringify({accounts,endpoint,submission,fingerprint:digest(canonicalize(feedbackSubmitSchema.parse(submission)))}));
 }else if(process.argv[2]==='read'){
  const admin={kind:'business-operator',endpoint,operatorId:'go-admin',role:'administrator'},reader={...admin,operatorId:'go-reader',role:'reader'};
  const businessAdmin=new BusinessAdminService({db:pool,endpoint,now});
  await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['feedback.read']});
  const service=new OperationsFeedbackService({businessAdmin,now}),id=process.argv[3];
  console.log(JSON.stringify({list:await service.list(admin,{days:'all',limit:1}),detail:await service.get(admin,id)}));
 }else throw Error('fixture command required');
}finally{await pool.end();}
