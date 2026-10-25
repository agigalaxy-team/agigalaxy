import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {OperationsCommunityService} from '../src/operations-community.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {createApi} from '../src/http.mjs';

test('exact content identifiers narrow candidates before the unchanged real qualification, while ordinary keyword search and permission boundaries remain intact',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'identifier-admin',role:'administrator',endpoint:f.endpoint},denied={kind:'business-operator',operatorId:'identifier-reader',role:'reader',endpoint:f.endpoint};
 for(const actor of [admin,denied])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operations.example.org',$1,'定向读取测试',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,now:f.now,operatorAuthorization:async actor=>actor.operatorId===admin.operatorId?'administrator':actor.operatorId===denied.operatorId?'reader':null}),businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now,permissions});
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now}),service=community.content;
 async function publish(title,body,audience={read:{kind:'everyone'},participate:{kind:'accounts'}}){const owner=f.people[0],payload=await bindForumIds('create-post','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:owner.accountId,title,body,links:[],topic:'technology',audience,publishedUntil:f.now()+3600});await forum.publish(owner,{payloadJson:JSON.stringify(payload)});return payload;}
 const original=await publish('文件命名的问题','想让文件名容易找到，保留日期还是保留主题？'),related=await publish('另一条公开讨论','这段正文提到了 '+original.postId),privatePost=await publish('不得暴露的标题','PRIVATE_IDENTIFIER_SOURCE',{read:{kind:'accounts'},participate:{kind:'accounts'}});
 const readIds=[],view=service.viewWithin.bind(service);service.viewWithin=(db,actor,kind,id,options)=>{readIds.push({kind,id});return view(db,actor,kind,id,options);};
 const exact=await service.list(admin,{days:'all',targetId:original.postId});assert.equal(exact.items.length,1);assert.equal(exact.items[0].id,original.postId);assert.equal(exact.summary.total,1);assert.equal(exact.nextAfter,null);assert.equal(exact.scanTruncated,false);assert.deepEqual(readIds,[{kind:'post',id:original.postId}]);
 assert.equal((await service.list(admin,{days:'all',targetId:original.postId,kind:'reply'})).items.length,0);
 assert.equal((await service.list(admin,{days:'all',targetId:randomUUID()})).items.length,0);
 const privateRead=await service.list(admin,{days:'all',targetId:privatePost.postId});assert.equal(privateRead.items.length,0);assert(!JSON.stringify(privateRead).includes('PRIVATE_IDENTIFIER_SOURCE'));assert(!JSON.stringify(privateRead).includes('不得暴露的标题'));
 const oldText=await service.list(admin,{days:'all',query:original.postId});assert(oldText.items.some(item=>item.id===original.postId));assert(oldText.items.some(item=>item.id===related.postId),'Legacy text query may still match an identifier quoted in another body');
 const keyword=await service.list(admin,{days:'all',query:'文件命名'});assert.equal(keyword.items.length,1);assert.equal(keyword.items[0].id,original.postId);
 await assert.rejects(service.list(denied,{days:'all',targetId:original.postId}),{code:'operations_permission_denied'});
 const origin='https://admin.example.org',server=createApi({bindings:{endpoint:f.endpoint},operations:{portal:{authorizeOperator:async request=>{if(request.headers.origin!==origin)throw new ServiceError('business_admin_denied',403);return request.headers['x-reader']==='true'?denied:admin;}}},operationsCommunity:community,browserOrigins:[origin],rateLimit:250});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port+'/v1/operations/community/content',headers={Origin:origin};
 const response=await fetch(base+'?days=all&targetId='+original.postId,{headers});assert.equal(response.status,200);assert.equal((await response.json()).items[0].id,original.postId);
 for(const query of ['targetId=not-an-id','targetId='+original.postId+'&targetId='+related.postId,'targetId='+original.postId+'&unexpected=true']){const invalid=await fetch(base+'?'+query,{headers});assert.equal(invalid.status,400);await invalid.arrayBuffer();}
 const unauthorized=await fetch(base+'?targetId='+original.postId,{headers:{...headers,'X-Reader':'true'}});assert.equal(unauthorized.status,403);await unauthorized.arrayBuffer();
 const current=await forum.getPost(original.postId);assert.equal(current.payload.body,original.body);assert.equal(current.payload.title,original.title);assert.equal(current.payload.publishedUntil,original.publishedUntil);
});
