import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer,request as httpRequest } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { spawn,execFileSync } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join,isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../../src/http.mjs';

test('real HTTPS API probes flow through Blackbox and Prometheus, fail and recover',{timeout:60000},async()=>{
  for(const key of ['GALAXY_TEST_BLACKBOX_BIN','GALAXY_TEST_PROMETHEUS_BIN','GALAXY_TEST_OPENSSL_BIN'])
    assert.ok(isAbsolute(process.env[key]??''),'Explicit absolute fixture binary required: '+key);
  const directory=await mkdtemp(join(tmpdir(),'galaxy-independent-monitor-'));
  const children=[],servers=[];
  const deadline=Date.now()+50000;
  const startServer=async server=>{servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
  const reservePort=async()=>{const server=createServer();const port=await startServer(server);await new Promise(resolve=>server.close(resolve));return port;};
  const start=(binary,args)=>{
    const child=spawn(binary,args,{windowsHide:true,stdio:'ignore'});
    const exit=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
    children.push({child,exit});return child;
  };
  const until=async check=>{
    while(Date.now()<deadline){
      for(const {child} of children)assert.equal(child.exitCode,null,'Monitor process exited');
      if(await check())return;
      await delay(100);
    }
    assert.fail('Local monitor integration timed out');
  };
  try{
    const keyPath=join(directory,'key.pem'),caPath=join(directory,'ca.pem');
    execFileSync(process.env.GALAXY_TEST_OPENSSL_BIN,['req','-x509','-newkey','rsa:2048','-noenc','-sha256','-days','2',
      '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyPath,'-out',caPath],{windowsHide:true,stdio:'ignore',timeout:15000});
    let ready=true,mode='normal';
    const apiPort=await startServer(createApi({bindings:{endpoint:'https://127.0.0.1'},readiness:async()=>ready}));
    const tls=createTlsServer({key:await readFile(keyPath),cert:await readFile(caPath)},(request,response)=>{
      if(request.url==='/'){response.end('<html><body>Fixture website</body></html>');return;}
      if(mode==='wrong-body'){response.setHeader('Content-Type','application/json');response.end('{"status":"not-ready"}');return;}
      if(mode==='redirect'){response.writeHead(302,{location:'/'});response.end();return;}
      const forwarded=httpRequest({hostname:'127.0.0.1',port:apiPort,path:request.url},upstream=>{
        response.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(response);
      });
      forwarded.on('error',()=>{response.writeHead(502);response.end();});forwarded.end();
    });
    tls.on('tlsClientError',()=>{});
    const origin='https://127.0.0.1:'+await startServer(tls);
    const config=JSON.parse(await readFile(new URL('../../../../docs/monitoring/blackbox.json',import.meta.url),'utf8'));
    config.modules.fixture_untrusted=structuredClone(config.modules.galaxy_readiness_https);
    for(const name of ['galaxy_website_https','galaxy_liveness_https','galaxy_readiness_https'])
      config.modules[name].http.tls_config.ca_file=caPath;
    const blackboxPath=join(directory,'blackbox.json');await writeFile(blackboxPath,JSON.stringify(config));
    const blackboxPort=await reservePort(),promPort=await reservePort();
    start(process.env.GALAXY_TEST_BLACKBOX_BIN,['--config.file='+blackboxPath,'--web.listen-address=127.0.0.1:'+blackboxPort,'--log.level=error','--log.prober=error']);
    const exporter='http://127.0.0.1:'+blackboxPort;
    await until(async()=>{try{return (await fetch(exporter+'/metrics',{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}});
    const probe=async(module,target=origin+'/readyz')=>{
      const response=await fetch(exporter+'/probe?'+new URLSearchParams({module,target}),{signal:AbortSignal.timeout(10000)});
      assert.equal(response.status,200);return response.text();
    };
    assert.match(await probe('galaxy_readiness_https'),/^probe_success 1$/m);
    assert.match(await probe('fixture_untrusted'),/^probe_success 0$/m);
    assert.match(await probe('galaxy_readiness_https','http://127.0.0.1:'+apiPort+'/readyz'),/^probe_success 0$/m);
    mode='wrong-body';assert.match(await probe('galaxy_readiness_https'),/^probe_success 0$/m);
    mode='redirect';assert.match(await probe('galaxy_readiness_https'),/^probe_success 0$/m);mode='normal';
    const prom=JSON.parse(await readFile(new URL('../../../../docs/monitoring/prometheus.example.json',import.meta.url),'utf8'));
    prom.global={scrape_interval:'1s',scrape_timeout:'900ms',evaluation_interval:'1s'};
    // Rule timing is covered by promtool fixtures; this test exercises real scrape transport.
    delete prom.rule_files;delete prom.alerting;
    for(const job of prom.scrape_configs){
      delete job.scrape_timeout;
      if(job.job_name==='galaxy-blackbox-exporter'){job.static_configs[0].targets=['127.0.0.1:'+blackboxPort];continue;}
      const suffix=job.job_name.endsWith('website')?'/':job.job_name.endsWith('liveness')?'/healthz':'/readyz';
      job.static_configs[0].targets=[origin+suffix];job.relabel_configs[2].replacement='127.0.0.1:'+blackboxPort;
    }
    const promPath=join(directory,'prometheus.json');await writeFile(promPath,JSON.stringify(prom));
    start(process.env.GALAXY_TEST_PROMETHEUS_BIN,['--config.file='+promPath,'--storage.tsdb.path='+join(directory,'tsdb'),'--web.listen-address=127.0.0.1:'+promPort,'--log.level=error']);
    const query=async expression=>{
      try{
        const response=await fetch('http://127.0.0.1:'+promPort+'/api/v1/query?'+new URLSearchParams({query:expression}),{signal:AbortSignal.timeout(1500)});
        if(!response.ok)return [];
        const data=await response.json();return data.data?.result??[];
      }catch{return [];}
    };
    const samples=()=>query('probe_success{job=~"galaxy-external-.*"}');
    await until(async()=>{const rows=await samples();return rows.length===3&&rows.every(row=>row.value[1]==='1');});
    ready=false;
    await until(async()=>{const rows=await samples();return rows.length===3&&rows.every(row=>row.value[1]===(row.metric.scope==='api-readiness'?'0':'1'));});
    ready=true;
    await until(async()=>{const rows=await samples();return rows.length===3&&rows.every(row=>row.value[1]==='1');});
    const observations=await query('timestamp(probe_success{job=~"galaxy-external-.*"})');
    assert.equal(observations.length,3);
    for(const row of observations)assert.ok(Date.now()/1000-Number(row.value[1])<10,'Fresh observation time required');
  }finally{
    for(const {child} of children)child.kill();
    await Promise.all(children.map(item=>item.exit));
    for(const server of servers){server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}
    await rm(directory,{recursive:true,force:true});
  }
});
