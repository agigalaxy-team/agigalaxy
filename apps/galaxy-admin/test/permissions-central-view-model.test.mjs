import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchPending,workbenchInventory,workbenchJobState,workbenchRecords} from "../src/lib/workbench/workbench-view-model.ts";
import {auditActionLabel,auditAvailableActions,auditMetadata,auditRoleLabel} from '../src/lib/audit-view-model.ts';

test('partial business authority leaves withheld dashboard data unknown and new authorization audit fields remain closed',()=>{
 const denied={communityReports:null,chatReports:null,sections:null,resources:null,files:null,jobs:null,search:null,feedback:null,businessActivity:null,recentOperations:null,
  availability:Object.fromEntries(['communityReports','chatReports','sections','resources','files','jobs','search','feedback','businessActivity','recentOperations'].map(key=>[key,'not-authorized']))};
 assert.deepEqual(workbenchPending(denied),[]);assert.deepEqual(workbenchRecords(denied),[]);assert.equal(workbenchJobState(denied),null);
 assert(workbenchInventory(denied).every(item=>item.value===null&&item.denied===true));
 const allowed={...denied,feedback:{pending:2,processing:1,total:3,unclassified:0},files:{scanFailed:0,cleanupFailed:null,cleanupResultUnknown:1}};
 const items=workbenchPending(allowed);assert.deepEqual(items.map(item=>[item.id,item.count]),[['cleanup-unknown',1],['feedback-pending',2],['feedback-processing',1]]);
 assert.equal(items[0].href,'/admin/operations/files?issue=cleanup');assert.equal(items.some(item=>item.label.includes('清理失败')),false);
 assert.equal(auditRoleLabel('reader'),'管理成员');assert.equal(auditActionLabel('permission-role-save'),'保存业务角色');
 assert.deepEqual(auditAvailableActions(['permission-role-save','PRIVATE_ACTION']),['permission-role-save']);
 const metadata=auditMetadata({changedFields:['name','permissions','enabled','PRIVATE_FIELD'],permissionCount:2,enabled:false,name:'PRIVATE_NAME',description:'PRIVATE_DESCRIPTION',permissions:['PRIVATE_PERMISSION']});
 assert.equal(metadata.find(item=>item.key==='changedFields').value,'名称、功能权限、启用状态');assert.equal(metadata.find(item=>item.key==='permissionCount').value,'2');
 assert.equal(JSON.stringify(metadata).includes('PRIVATE_'),false);
});
