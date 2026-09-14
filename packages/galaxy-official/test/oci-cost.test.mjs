import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectOciCost,refreshOciCost } from '../scripts/collect-oci-cost.mjs';
import { loadMetricsConfiguration,createOperationalMetrics } from '../src/operations/metrics.mjs';

const config={version:1,cli:process.execPath,auth:'instance_principal',region:'ap-kulai-1',tenantId:'ocid1.tenancy.oc1..fixture',
  scope:{dimension:'resourceId',values:['ocid1.instance.oc1..fixture','ocid1.volume.oc1..fixture']},currency:'USD',budget:30};
const now=new Date('2026-09-11T05:00:00Z');
const row=amount=>({'computed-amount':amount,currency:'USD','time-usage-started':'2026-09-01T00:00:00+00:00','time-usage-ended':'2026-09-11T00:00:00+00:00','is-forecast':false});

test('OCI paginated scoped cost feeds hot-reloaded metrics and preserves last observation on failed refresh',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-oci-cost-')),output=join(directory,'cost.json');
  const calls=[];
  try{
    const receipt=await refreshOciCost(config,output,{now,run:async(cli,args)=>{
      assert.equal(cli,process.execPath);calls.push(args);
      return calls.length===1?{data:{items:[row(1.25)]},'opc-next-page':'page-two'}:{data:{items:[row(2.5)]}};
    }});
    assert.equal(receipt.pages,2);assert.equal(receipt.rows,2);
    assert.equal(calls[1].at(-1),'page-two');
    const option=name=>calls[0][calls[0].indexOf(name)+1];
    assert.equal(option('--query-type'),'COST');assert.equal(option('--auth'),'instance_principal');
    assert.equal(option('--time-usage-ended'),'2026-09-11T00:00:00.000Z');
    assert.deepEqual(JSON.parse(option('--filter')),{operator:'OR',dimensions:config.scope.values.map(value=>({key:'resourceId',value}))});
    assert.doesNotMatch(JSON.stringify(receipt),/ocid1|fixture|USD/);
    const saved=await readFile(output,'utf8'),metrics=createOperationalMetrics({component:'api',defaultMetrics:false,cacheMs:0,
      ...await loadMetricsConfiguration({GALAXY_METRICS_COST_FILE:output})});
    await metrics.render();
    assert.equal((await metrics.registry.getSingleMetric('galaxy_cost_amount').get()).values[0].value,3.75);
    await assert.rejects(refreshOciCost(config,output,{now,run:async()=>{throw new Error('query failed');}}));
    assert.equal(await readFile(output,'utf8'),saved);
    await refreshOciCost(config,output,{now,run:async()=>({data:{items:[row(0)]}})});
    await metrics.render();
    assert.equal((await metrics.registry.getSingleMetric('galaxy_cost_amount').get()).values[0].value,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('OCI collector rejects incomplete, mixed, forecast or looping data instead of publishing misleading zero costs',async()=>{
  for(const response of [{data:{items:[]}},{data:{items:[{...row(1),currency:'CNY'}]}},{data:{items:[row(null)]}},
    {data:{items:[{...row(1),'is-forecast':true}]}},{data:{items:[{...row(1),'time-usage-ended':'2026-09-12T00:00:00Z'}]}},
    {data:{items:[row(1)]},'opc-next-page':'repeated'}])
    await assert.rejects(collectOciCost(config,{now,run:async()=>response}));
  let called=false;
  await assert.rejects(collectOciCost({...config,scope:{dimension:'resourceId',values:[]}},{now,run:async()=>{called=true;}}));
  await assert.rejects(collectOciCost(config,{now:new Date('2026-10-01T05:00:00Z'),run:async()=>{called=true;}}));
  assert.equal(called,false);
});

test('OCI aggregate rows without per-row timestamps use the explicit query window',async()=>{
  const aggregated={...row(2.75),'time-usage-started':null,'time-usage-ended':null};
  const result=await collectOciCost(config,{now,run:async(_cli,args)=>{
    assert.equal(args[args.indexOf('--is-aggregate-by-time')+1],'true');
    return {data:{items:[aggregated]}};
  }});
  assert.equal(result.cost.amount,2.75);
  assert.equal(result.receipt.rowsUsingQueryWindow,1);
  assert.equal(result.receipt.queriedThrough,'2026-09-11T00:00:00.000Z');
  for(const invalid of [{...aggregated,'time-usage-started':'2026-09-01T00:00:00Z'},
    {...aggregated,'time-usage-ended':'2026-09-11T00:00:00Z'},
    {...aggregated,'computed-amount':null}])
    await assert.rejects(collectOciCost(config,{now,run:async()=>({data:{items:[invalid]}})}));
});

test('actual costs without an operator budget remain measurable and cannot leave a stale or fabricated budget',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-cost-without-budget-')),output=join(directory,'cost.json');
  const run=async()=>({data:{items:[row(4.5)]}});
  try{
    const receipt=await refreshOciCost({...config,budget:undefined},output,{now,run});
    assert.equal(receipt.budgetConfigured,false);
    const cost=JSON.parse(await readFile(output,'utf8'));
    assert.equal(cost.version,2);assert.equal(cost.budget,null);
    assert.equal(cost.scope.attribution,'unallocated');assert.equal(cost.scope.count,2);
    assert.doesNotMatch(JSON.stringify(cost),/ocid1|fixture/);
    const metrics=createOperationalMetrics({component:'api',defaultMetrics:false,cacheMs:0,
      ...await loadMetricsConfiguration({GALAXY_METRICS_COST_FILE:output})});
    const values=async name=>(await metrics.registry.getSingleMetric('galaxy_'+name).get()).values;
    await metrics.render();
    assert.equal((await values('cost_amount'))[0].value,4.5);
    assert.equal((await values('cost_budget_configured'))[0].value,0);
    assert.deepEqual(await values('cost_budget'),[]);
    assert.equal((await values('cost_scope_info'))[0].labels.attribution,'unallocated');
    await refreshOciCost({...config,budget:0},output,{now,run});await metrics.render();
    assert.equal((await values('cost_budget_configured'))[0].value,1);
    assert.equal((await values('cost_budget'))[0].value,0,'explicit zero differs from an unknown budget');
    await refreshOciCost({...config,budget:null},output,{now,run});await metrics.render();
    assert.deepEqual(await values('cost_budget'),[]);
    await writeFile(output,JSON.stringify({...cost,scope:{...cost.scope,attribution:'galaxy-dedicated'}}));
    await metrics.render();
    assert.equal((await values('cost_input_available'))[0].value,0);
    assert.equal((await values('cost_budget_configured'))[0].value,0);
    assert.deepEqual(await values('cost_scope_info'),[]);
  }finally{await rm(directory,{recursive:true,force:true});}
});
