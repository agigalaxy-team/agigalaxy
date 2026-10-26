import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {OperationsPermissionsService} from '../src/operations/permissions/service.mjs';
import {createStoredOperatorAuthorization,createStoredManagementMaintainerAuthorization} from "../src/operations/configuration.mjs";
import {createOperationsManagementSessions} from "../src/operations/accounts/management-sessions.mjs";
import {ManagementAccountsReadModel} from '../src/operations/accounts/management-read-model.mjs';
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {operationsPermissionCodes} from '../src/operations-permission-catalog.mjs';
import {managementMaintainerPermissionCodes} from '../src/shared/operations-management-maintainer-actions.mjs';
import {personPermissionImpact} from "../../../apps/galaxy-admin/src/lib/permissions/permissions-view-model.ts";

// One real PG/API-role/current stored-identity authority leaf. Native identity
// directory is an explicit per-target double; no browser/OIDC/session token,
// production account, qualification promotion, HTTP or provider is invoked.
test('personnel role impact follows current target maintainer eligibility and the same management effective rule without granting eligibility',{timeout:90000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db);
 const endpoint='https://permission-impact.example',issuer='https://identity.example/realms/management',stamp='2030-01-01T00:00:00.000Z',now=()=>1893456000;
 const user=(sub,admission)=>({issuer,externalSubject:sub,operatorId:createHash('sha256').update(issuer+'\0'+sub).digest('hex'),username:sub,firstName:'本机',lastName:'夹具',email:null,emailVerified:false,enabled:true,createdAt:stamp,admission,requiredActions:[]});
 const rootUser=user('impact-root','administrator'),ordinaryUser=user('impact-ordinary','reader'),promotedUser=user('impact-promoted','administrator'),plainUser=user('impact-plain','reader');
 const users=new Map([rootUser,ordinaryUser,promotedUser,plainUser].map(v=>[v.externalSubject,v])),rootPrincipal=Object.freeze({version:1,endpoint,issuer,externalSubject:rootUser.externalSubject,operatorId:rootUser.operatorId}),unavailable=new Set(),nativeReads=[];
 const roleDirectory={async getOperatorRoles(principal){const found=users.get(principal.externalSubject);return found?.issuer===principal.issuer&&found.enabled?[found.admission==='administrator'?'native-admin':'native-reader']:[];},invalidateOperatorRoles(){return true;}};
 const directory={issuer,managementConfigured:true,async get(principal){nativeReads.push(principal.externalSubject);if(unavailable.has(principal.externalSubject))throw Error('Explicit native directory unavailable double');const found=users.get(principal.externalSubject);return found&&found.issuer===principal.issuer?{...found}:null;}};
 const sessions=createOperationsManagementSessions({db,endpoint,issuer,roleDirectory,now});
 const stored=createStoredOperatorAuthorization({db,endpoint,issuer,roles:{administrator:'native-admin',reader:'native-reader'},roleDirectory,rootPrincipal,managementSessions:sessions});
 const actualMaintainer=createStoredManagementMaintainerAuthorization({db,endpoint,issuer,rootPrincipal,managementDirectory:directory,managementSessions:sessions});let maintainerCalls=0;
 const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:stored,managementMaintainerAuthorization:async(...args)=>{maintainerCalls++;return actualMaintainer(...args);},now});
 const actor=v=>({kind:'business-operator',operatorId:v.operatorId,endpoint}),root=actor(rootUser),ordinary=actor(ordinaryUser),promoted=actor(promotedUser),plain=actor(plainUser);
 for(const value of users.values())await db.query('INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[value.operatorId,endpoint,issuer,value.externalSubject,'本机资格夹具',stamp]);
 await migrate(db,{roles:['api']});await db.exec('SET ROLE galaxy_api');
 const options={authorize:async()=>root},make=async(name,codes)=>(await permissions.saveRole(root,{operationId:randomUUID(),expectedVersion:0,name,description:'仅本机资格差额',enabled:true,permissions:codes},options)).role;
 const assign=async(role,target)=>(await permissions.saveAssignment(root,{operationId:randomUUID(),expectedVersion:0,operatorId:target.operatorId,roleId:role.id,enabled:true},options)).assignment;
 const viewing=await make('本机普通查看',['accounts.read']),future=await make('本机维护和分析',[...managementMaintainerPermissionCodes,'analytics.read']);
 await assign(viewing,ordinary);await assign(viewing,promoted);await assign(viewing,plain);
 const callsBeforeOrdinary=maintainerCalls,beforeDefault=await permissions.effective(ordinary);assert.equal(maintainerCalls,callsBeforeOrdinary,'Default ordinary effective without guarded actions adds no new qualification lookup');assert.equal(Object.hasOwn(beforeDefault,'managementEligibility'),false);
 const people=await permissions.personnel(root),ordinaryBefore=people.items.find(v=>v.operatorId===ordinary.operatorId),promotedBefore=people.items.find(v=>v.operatorId===promoted.operatorId),rootBefore=people.items.find(v=>v.operatorId===root.operatorId);
 const preview=personPermissionImpact(ordinaryBefore,[viewing,future],{assignment:{roleId:future.id,enabled:true}});
 assert.deepEqual(preview.added,['analytics.read'],'Ordinary target must not be promised eight maintainer actions merely because the reading actor is root');
 assert.equal(ordinaryBefore.managementEligibility,'unqualified');assert.equal(promotedBefore.managementEligibility,'qualified');assert.equal(rootBefore.managementEligibility,'qualified');
 assert.equal(preview.requiresAdministrator.length,8);assert.equal(personPermissionImpact(rootBefore,[viewing,future],{assignment:{roleId:future.id,enabled:true}}).state,'root');
 const businessAdmin=new BusinessAdminService({db,endpoint,operatorAuthorization:stored,permissions,now}),management=new ManagementAccountsReadModel({businessAdmin,directory,rootPrincipal,managementSessions:sessions,now});
 const compare=async(target,profile)=>{const effective=await permissions.effective(target),facts=await management.roleFacts(db,target.operatorId),same=management.effective(profile,{},facts);assert.deepEqual([...effective.permissions].sort((a,b)=>a<b?-1:a>b?1:0),same.permissions);return effective;};
 const ordinaryAssignment=await assign(future,ordinary),ordinaryActual=await compare(ordinary,ordinaryUser);
 assert.deepEqual(ordinaryActual.permissions,[...ordinaryBefore.effective.permissions,...preview.added].filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a<b?-1:a>b?1:0));assert(ordinaryActual.permissions.every(v=>!managementMaintainerPermissionCodes.includes(v)));
 const ordinaryWith=(await permissions.personnel(root)).items.find(v=>v.operatorId===ordinary.operatorId),revoke=personPermissionImpact(ordinaryWith,[viewing,future],{assignment:{roleId:future.id,enabled:false}});
 assert.deepEqual(revoke.removed,['analytics.read']);await permissions.saveAssignment(root,{operationId:randomUUID(),id:ordinaryAssignment.id,expectedVersion:ordinaryAssignment.version,operatorId:ordinary.operatorId,roleId:future.id,enabled:false},options);assert.deepEqual((await compare(ordinary,ordinaryUser)).permissions,['accounts.read']);
 const promotedPreview=personPermissionImpact(promotedBefore,[viewing,future],{assignment:{roleId:future.id,enabled:true}});assert.equal(promotedPreview.added.length,9);await assign(future,promoted);const promotedActual=await compare(promoted,promotedUser);assert.equal(promotedActual.source,'business-roles');assert(promotedActual.permissions.length<operationsPermissionCodes.length);assert(managementMaintainerPermissionCodes.every(v=>promotedActual.permissions.includes(v)));
 assert.equal((await sessions.summary({operatorId:promotedUser.operatorId,issuer,externalSubject:promotedUser.externalSubject})).activeCount,0,'Qualification is not conditional on target having a live portal session');
 const spoofed=await permissions.effective({...ordinary,role:'administrator',businessAuthorization:{version:'spoof',permissions:operationsPermissionCodes}},{includeManagementEligibility:true});assert.equal(spoofed.managementEligibility,'unqualified');assert.equal(spoofed.source,'business-roles');
 const beforeReads=(await db.query('SELECT count(*)::int AS n FROM operations_permission_events_v1')).rows[0].n;
 unavailable.add(plainUser.externalSubject);const plainUnknown=await permissions.effective(plain,{includeManagementEligibility:true});assert.equal(plainUnknown.managementEligibility,'unknown');assert.deepEqual(plainUnknown.permissions,['accounts.read']);const plainPerson=(await permissions.personnel(root)).items.find(v=>v.operatorId===plain.operatorId);assert.equal(plainPerson.authorizationState,'available');assert.equal(plainPerson.managementEligibility,'unknown');assert.equal(personPermissionImpact(plainPerson,[viewing,future],{assignment:{roleId:future.id,enabled:true}}).state,'unknown');
 assert.deepEqual(personPermissionImpact({...ordinaryBefore,managementEligibility:undefined},[viewing,future],{assignment:{roleId:future.id,enabled:true}}).state,'unknown','Old server DTO cannot infer qualification');assert.equal(personPermissionImpact({...ordinaryBefore,managementEligibility:'unknown'},[viewing],{assignment:{roleId:viewing.id,enabled:false}}).state,'known','Unrelated ordinary rights can still be calculated');
 unavailable.add(promotedUser.externalSubject);await assert.rejects(permissions.effective(promoted,{includeManagementEligibility:true}),/Explicit native directory unavailable double/,'Existing guarded authority still fails closed when required qualification cannot be checked');unavailable.delete(promotedUser.externalSubject);
 promotedUser.admission='reader';const demoted=await permissions.effective(promoted,{includeManagementEligibility:true});assert.equal(demoted.managementEligibility,'unqualified');assert.deepEqual(demoted.permissions,['accounts.read','analytics.read']);assert.deepEqual(demoted.permissions,management.effective(promotedUser,{},await management.roleFacts(db,promoted.operatorId)).permissions);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_permission_events_v1')).rows[0].n,beforeReads,'Eligibility reads and previews append no role/assignment event');
 assert(nativeReads.includes(ordinaryUser.externalSubject)&&nativeReads.includes(promotedUser.externalSubject)&&nativeReads.includes(plainUser.externalSubject));assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_operator_sessions_v1')).rows[0].n,0);
 await assert.rejects(permissions.effective({...ordinary,endpoint:'https://foreign.example'},{includeManagementEligibility:true}),{code:'business_admin_denied'});
});

