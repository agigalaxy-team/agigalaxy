import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {CommunityAccountRegistry} from "../src/accounts/community-accounts.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';
import {queueFixture} from './operations-jobs-fixture.mjs';

// PG/domain/queue transactions are real. The current management directory is a
// controlled provider, not a claim that a live Keycloak service was exercised.
export async function operationsProductFixture(t,{accountCount=2}={}){
// eslint-disable-next-line prefer-const -- Forward references must stay initialized to undefined when setup fails before assignment.
  const db=new PGlite();let queue;let clock=2000000000,currentRole='administrator',directoryAvailable=true,checks=0;
  t.after(async()=>{await queue?.jobs.stop();await db.close();});await migrate(db);
  const endpoint='https://product.example.invalid',issuer='https://management.example.invalid/realms/galaxy-operations';
  const now=()=>clock,actor={kind:'business-operator',operatorId:issuer+'|synthetic-maintainer',role:'administrator',endpoint,httpRequestId:randomUUID()};
  const businessAdmin=new BusinessAdminService({db,endpoint,now,operatorAuthorization:async operator=>{
    checks++;if(!directoryAvailable)throw new ServiceError('identity_directory_unavailable',503);
    return operator.operatorId===actor.operatorId?currentRole:null;
  }});
  const reader={...actor,operatorId:actor.operatorId+'-reader',role:'reader'};
  const currentAuthorization=businessAdmin.operatorAuthorization;
  businessAdmin.operatorAuthorization=async current=>current.operatorId===reader.operatorId?'reader':currentAuthorization(current);
  const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:businessAdmin.operatorAuthorization});businessAdmin.permissions=permissions;
  for(const principal of [actor,reader])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$1,'本地管理合同',$4,$4)",[principal.operatorId,endpoint,issuer,new Date(now()*1000)]);
  const role=(await permissions.saveRole(actor,{operationId:randomUUID(),expectedVersion:0,name:'只读产品合同',description:'',enabled:true,permissions:['rules.read','notices.read','retention.read','audit.read']},{authorize:async()=>actor})).role;
  await permissions.saveAssignment(actor,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},{authorize:async()=>actor});
  queue=queueFixture(db);await queue.jobs.start();
  const accounts=new CommunityAccountRegistry({db,endpoint,now}),people=[];
  async function addAccount(){
    const id=randomUUID(),at=new Date(clock*1000).toISOString();
    await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
      VALUES($1,$2,'https://business.example.invalid/realms/galaxy',$3,'email',$4,$4)`,[id,endpoint,id,at]);
    const person={kind:'official-account',accountId:id,endpoint};people.push(person);return person;
  }
  for(let index=0;index<accountCount;index++)await addAccount();
  return {db,endpoint,now,actor,reader,businessAdmin,accounts,people,addAccount,jobs:queue.jobs,
    advance:seconds=>{clock+=seconds;},setRole:role=>{currentRole=role;},directoryAvailable:value=>{directoryAvailable=value;},authorizationChecks:()=>checks};
}
