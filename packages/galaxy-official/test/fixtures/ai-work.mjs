import {randomUUID} from 'node:crypto';
import {OperationsAiWorkAccountsService} from '../../src/operations/accounts/ai-work-service.mjs';

// Explicit local identities and real SQL role assignments. These fixtures do
// not turn actor role claims into an AI grant or replace current authority.
export async function attachAiWorkFixture({db,endpoint,permissions,businessAdmin,authority,admin,domains,codes,now}){
 const accounts=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,now});
 permissions.aiWorkAccounts=accounts;authority.aiWorkAccounts=accounts;
 const role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,
  name:'本地岗位合同 '+randomUUID(),description:'Explicit isolated fixture',enabled:true,permissions:codes},
  {authorize:async()=>admin})).role;
 const ids={};
 for(const domain of domains){
  const id=randomUUID();ids[domain]=id;
  await db.query("INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,$3,'本地合同岗位','',true,1,1,$4,$4)",[id,endpoint,domain,new Date(now()*1000)]);
  await accounts.assignment(admin,domain,{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize:async()=>admin});
 }
 return {accounts,ids};
}
