import assert from 'node:assert/strict';
import test from 'node:test';
import {maintenanceApprovalBody,maintenanceBytes,maintenanceCount,maintenanceCurrentAuthorityDeclared,maintenanceExecutionBody,maintenanceHref,maintenanceLocation,maintenanceNext,maintenancePath,maintenancePrevious,maintenanceRestoreBasis} from '../src/lib/maintenance-view-model.ts';

test('maintenance navigation retains selected objects and exact native time cursors without sending UI context',()=>{
 const point='a'.repeat(64),plan='123e4567-e89b-42d3-a456-426614174000',before='1792748400123456789';
 const location=maintenanceLocation({tab:'logs',point,plan,before,component:'business-db',level:'error',period:'24h',backupAfter:'b'.repeat(64),backupTrail:JSON.stringify(['']),historyAfter:'27'});
 const request=new URL(maintenancePath('logs',location),'http://localhost');
 assert.deepEqual([...request.searchParams.keys()].sort(),['before','component','level','limit','period']);
 assert.equal(request.searchParams.get('before'),before);assert.equal(request.searchParams.get('component'),'business-db');
 const href=new URL(maintenanceHref(location,{tab:'backups'}),'http://localhost');
 assert.equal(href.searchParams.get('point'),point);assert.equal(href.searchParams.get('plan'),plan);assert.equal(href.searchParams.get('before'),before);
 assert.equal(maintenancePath('point',location),'/v1/operations/maintenance/backups/'+point);
 const changed=maintenanceLocation({...location,...maintenanceNext(location,'backups','c'.repeat(64))});
 const returned=maintenanceLocation({...changed,...maintenancePrevious(changed,'backups')});
 assert.equal(returned.backupAfter,location.backupAfter);assert.equal(returned.point,point);assert.equal(returned.plan,plan);
 assert.equal(maintenanceLocation({point:'../secret',plan:'wrong',before:'not-time',backupTrail:'["../../"]',component:'x/y'}).point,'');
 assert.equal(maintenanceLocation({before:'not-time'}).before,'');
});

test('maintenance unknown quantities remain unknown while explicitly recorded zero remains zero',()=>{
 assert.equal(maintenanceCount(null),'未取得');assert.equal(maintenanceCount(undefined),'未取得');assert.equal(maintenanceCount(0),'0');
 assert.equal(maintenanceBytes(null),'未取得');assert.equal(maintenanceBytes(0),'0 B');
 assert.equal(maintenanceBytes(-1),'未取得');assert.equal(maintenanceCount(Number.NaN),'未取得');
});

test('maintenance approval and execution bind the exact readable plan and cannot bypass service capabilities',()=>{
 const detail={plan:{id:'123e4567-e89b-42d3-a456-426614174000',revision:3,state:'awaiting-approval',planDigest:'d'.repeat(64),preservedCurrent:{state:'declared',items:['accounts','passwords','current-permissions','keys'],basis:'current-security-authority'},blockers:[],approval:null},permissions:{canApprove:true,canExecute:false,canCancel:true}};
 const body=maintenanceApprovalBody(detail);
 assert.deepEqual(body,{expectedRevision:3,expectedPlanDigest:'d'.repeat(64),acknowledgement:{point:true,scope:true,possibleLoss:true,openingConditions:true}});
 assert.equal(maintenanceApprovalBody({...detail,permissions:{...detail.permissions,canApprove:false}}),null);
 assert.equal(maintenanceApprovalBody({...detail,plan:{...detail.plan,blockers:['maintenance_production_adapter_unavailable']}}),null);
 assert.equal(maintenanceApprovalBody({...detail,plan:{...detail.plan,state:'blocked'}}),null);
 const approved={...detail,plan:{...detail.plan,state:'approved',revision:4,approval:{operatorId:'management-principal',revision:4,at:'2026-10-23T08:00:00Z'}},permissions:{...detail.permissions,canApprove:false,canExecute:true}};
 assert.deepEqual(maintenanceExecutionBody(approved),{expectedRevision:4});
 assert.equal(maintenanceExecutionBody({...approved,permissions:{...approved.permissions,canExecute:false}}),null);
 assert.equal(maintenanceExecutionBody({...approved,plan:{...approved.plan,blockers:['maintenance_production_adapter_unavailable']}}),null);
 assert.equal(maintenanceExecutionBody({...approved,plan:{...approved.plan,revision:5}}),null);
 assert.equal(maintenanceExecutionBody({...approved,plan:{...approved.plan,state:'cancelled'}}),null);
});

test('restore A requires the recorded current security authority without backfilling old plans or extending approval payload',()=>{
 const preservedCurrent={state:'declared',items:['accounts','passwords','current-permissions','keys'],basis:'current-security-authority'};
 const detail={plan:{revision:3,state:'awaiting-approval',planDigest:'d'.repeat(64),blockers:[],approval:null,preservedCurrent},permissions:{canApprove:true,canExecute:true,canCancel:true}};
 assert.equal(maintenanceCurrentAuthorityDeclared(detail.plan),true);
 for(const value of [undefined,{state:'not-recorded',items:[],basis:null},{...preservedCurrent,basis:null},{...preservedCurrent,items:['accounts','passwords','keys']},{...preservedCurrent,items:['accounts','passwords','keys','keys']},{...preservedCurrent,items:[...preservedCurrent.items,'synthetic-unknown']}]){
  const plan={...detail.plan,preservedCurrent:value};assert.equal(maintenanceCurrentAuthorityDeclared(plan),false);assert.equal(maintenanceApprovalBody({...detail,plan}),null);
  assert.equal(maintenanceExecutionBody({...detail,plan:{...plan,state:'approved',approval:{revision:3}}}),null);
 }
 assert.deepEqual(Object.keys(maintenanceApprovalBody(detail)).sort(),['acknowledgement','expectedPlanDigest','expectedRevision']);
 assert.equal(maintenanceRestoreBasis('current-security-authority'),'保留当前状态');
 assert.equal(maintenanceRestoreBasis('point-with-current-permissions'),'按恢复点，保留当前权限');
 assert.equal(maintenanceRestoreBasis('point-with-current-keys'),'按恢复点，保留当前密钥');
 assert.equal(maintenanceRestoreBasis('selected-recovery-point'),'按所选恢复点');
 assert.equal(maintenanceRestoreBasis('unrecorded-private-details'),'处理方式未记录');
});
