import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('actual Alertmanager routes firing and resolved alerts to loopback receiver',{timeout:60000},async()=>{
  assert.ok(process.env.GALAXY_TEST_ALERTMANAGER_BIN,'Set GALAXY_TEST_ALERTMANAGER_BIN to an explicit local binary');
  const directory=await mkdtemp(join(tmpdir(),'galaxy-alertmanager-'));
  const deliveries=[];
  const receiver=createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    deliveries.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200);response.end('{}');
  });
  let child,exit;
  try{
    receiver.listen(0,'127.0.0.1');await once(receiver,'listening');
    const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
    const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
    const config=JSON.parse(await readFile(new URL('../../../../docs/alerts/alertmanager.example.json',import.meta.url),'utf8'));
    config.route.group_wait='0s';config.route.group_interval='1s';config.route.repeat_interval='1h';
    config.receivers=config.receivers.map(entry=>({...entry,webhook_configs:[{url:'http://127.0.0.1:'+receiver.address().port+'/',send_resolved:true}]}));
    const path=join(directory,'config.json');await writeFile(path,JSON.stringify(config));
    child=spawn(process.env.GALAXY_TEST_ALERTMANAGER_BIN,['--config.file='+path,'--storage.path='+join(directory,'data'),'--web.listen-address=127.0.0.1:'+port,'--cluster.listen-address='],{windowsHide:true,stdio:'ignore'});
    exit=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
    const endpoint='http://127.0.0.1:'+port;
    const deadline=Date.now()+45000;
    async function until(check){
      while(Date.now()<deadline){
        assert.equal(child.exitCode,null,'Alertmanager exited prematurely');
        if(await check())return;
        await delay(100);
      }
      assert.fail('Timed out waiting for local Alertmanager');
    }
    await until(async()=>{try{return (await fetch(endpoint+'/-/ready',{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}});
    const startsAt=new Date(Date.now()-60000).toISOString();
    const alerts=['operations','identity','data'].map(owner_role=>({labels:{alertname:'GalaxyLocalDeliveryFixture',job:'synthetic',instance:'loopback',owner_role,severity:'warning'},annotations:{summary:'Synthetic local notification test'},startsAt,endsAt:new Date(Date.now()+300000).toISOString()}));
    const post=async payload=>assert.equal((await fetch(endpoint+'/api/v2/alerts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).status,200);
    await post(alerts);
    await until(async()=>['operations','identity','data'].every(role=>deliveries.some(item=>item.status==='firing'&&item.receiver===role)));
    await post(alerts.map(item=>({...item,endsAt:new Date(Date.now()-1000).toISOString()})));
    await until(async()=>['operations','identity','data'].every(role=>deliveries.some(item=>item.status==='resolved'&&item.receiver===role)));
    assert.ok(deliveries.every(item=>item.alerts.every(alert=>alert.labels.job==='synthetic')));
  }finally{
    if(child){child.kill();await exit;}
    receiver.closeAllConnections();await new Promise(resolve=>receiver.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});
