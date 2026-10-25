import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrations} from '../src/infrastructure/migrations.mjs';
import {p14RulesV1MigrationSql} from '../src/infrastructure/p14-rules-v1-schema.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsProductRules} from '../src/operations-product-rules.mjs';
import {P14RulesService} from '../src/operations/rules/service.mjs';
import {P14RulesRuntime} from '../src/operations/rules/runtime.mjs';
import {defaultResourceBudgetPolicy} from '../src/infrastructure/resource-budgets.mjs';
import {defaultCommunityPolicy} from '../src/public-writes.mjs';
import {defaultForumPolicy} from '../src/community-forum-policy-v1.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {ForumAttachmentsV1Service} from '../src/forum-attachments-v1.mjs';

// Actual PG, current business grants, quotas and write services. Only the
// management directory, message transport and file/scanner I/O are doubles.
export async function p14Fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 if(!migrations.some(row=>row.version===111))await f.db.exec(p14RulesV1MigrationSql);
 const admin={kind:'business-operator',operatorId:'p14-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'p14-reader',role:'reader'},roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 for(const actor of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.invalid',$1,'合成规则维护者',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const operatorAuthorization=async actor=>roles.get(actor.operatorId)??null,permissions=new OperationsPermissionsService({...f,operatorAuthorization}),businessAdmin=new BusinessAdminService({...f,permissions,operatorAuthorization});
 const legacyRules=new OperationsProductRules({...f,businessAdmin});await legacyRules.bootstrap({'resource-budget':defaultResourceBudgetPolicy,'community-quota':defaultCommunityPolicy,'forum-quota':defaultForumPolicy});
 const rules=new P14RulesService({...f,businessAdmin,legacyRules});await rules.initialize();
 const runtime=new P14RulesRuntime(f),forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites});
 const objects=new Map(),store={keyId:'p14-synthetic-store',put:async({key,bytes})=>objects.set(key,Buffer.from(bytes)),get:async({key})=>objects.get(key),erase:async({key})=>objects.delete(key)},scanner={scan:async()=>({state:'clean',engine:'synthetic-local',guaranteedSafe:false})};
 const forumFiles=new ForumAttachmentsV1Service({forum,store,scanner});forum.attachments=forumFiles;
 // Production composition uses the same explicit hook holders.
 forum.businessRules=runtime;f.chat.businessRules=runtime;f.files.businessRules=runtime;forumFiles.businessRules=runtime;
 const authorize=async()=>admin;
 async function publish(policy,key='business-controls'){
  const detail=await rules.get(admin,key),saved=await rules.saveDraft(admin,key,{operationId:randomUUID(),expectedRevision:detail.revision,policy,reason:'本地规则场景'},{authorize});
  return rules.publish(admin,key,{operationId:randomUUID(),expectedRevision:saved.detail.revision,versionId:saved.detail.draft.id,reason:'发布已检查的本地规则场景'},{authorize});
 }
 return {...f,admin,reader,roles,permissions,businessAdmin,legacyRules,rules,runtime,forum,forumFiles,objects,authorize,publish};
}
