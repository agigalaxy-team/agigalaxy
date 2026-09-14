import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { join,relative,isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { migrate } from '../../src/database.mjs';
import { issueKeyring } from '../../src/trust-keyring.mjs';
import { verifyHubManifest,verifyManifest,hubManifestDigest } from '../../src/manifest.mjs';
import { verifyRuntimeConfigEvent } from '../../src/operations/runtime-config-audit.mjs';
import { hubProfile } from '../hub-manifest-fixture.mjs';

test('isolated PostgreSQL: actual Hub API loads selected profile and records its signed data digest', {timeout:45000},async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),temporary=await mkdtemp(join(tmpdir(),'galaxy-hub-process-'));let db;
  const children=[];
  async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return child.result;
    if(process.platform==='win32')child.send('stop-fixture');else{child.disconnect();child.kill('SIGTERM');}
    return child.result;}
  try{
    await admin.query('CREATE DATABASE galaxy_integration');db=new pg.Pool({database:'galaxy_integration'});await migrate(db);
    await db.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    const directory=join(temporary,'integration'),trust=join(directory,'trust');await mkdir(trust,{recursive:true});
    const root=generateKeyPairSync('ed25519'),key=generateKeyPairSync('ed25519'),now=Math.floor(Date.now()/1000),endpoint='https://hub.example.org';
    const pin=(pair,kid)=>({kid,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),notBefore:now-60,notAfter:now+200000,revoked:false});
    const paths={key:join(directory,'service.pem'),pins:join(directory,'pins.json'),ring:join(directory,'ring.json'),profile:join(directory,'network.json')};
    await writeFile(paths.key,key.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    await writeFile(paths.pins,JSON.stringify({version:1,endpoint,sequence:1,keys:[pin(root,'root')]}));
    await writeFile(paths.ring,JSON.stringify(await issueKeyring({endpoint,keys:[pin(key,'service')],sequence:1,rootKid:'root',rootPrivateKey:root.privateKey,now})));
    await writeFile(paths.profile,JSON.stringify(hubProfile));
    const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const database=new URL(`postgresql://${process.env.PGHOST}:${process.env.PGPORT}/galaxy_integration`);database.username=process.env.PGUSER;database.password=process.env.PGPASSWORD;
    const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GALAXY_')&&name!=='DATABASE_URL'));
    Object.assign(env,{GALAXY_ENVIRONMENT:'integration',GALAXY_ENVIRONMENT_DIRECTORY:directory,GALAXY_ENDPOINT:endpoint,DATABASE_URL:database.href,
      GALAXY_TRUST_DIRECTORY:trust,GALAXY_SIGNING_KEY_FILE:paths.key,GALAXY_SIGNING_KEY_ID:'service',GALAXY_ROOT_PINS_FILE:paths.pins,GALAXY_KEYRING_FILE:paths.ring,
      GALAXY_NETWORK_PROFILE_FILE:paths.profile,GALAXY_OPERATOR:'Synthetic Hub operator',GALAXY_REGION:'test',PORT:String(port),PGOPTIONS:'-c role=galaxy_api'});
    const launch=(expectStartupExit=false)=>{let phase='unknown';const args=process.platform==='win32'&&!expectStartupExit?['--import',new URL('./stop-channel.mjs',import.meta.url).href]:[];
      const child=spawn(process.execPath,[...args,fileURLToPath(new URL('../../src/server.mjs',import.meta.url))],{env,windowsHide:true,stdio:expectStartupExit?['ignore','pipe','pipe']:['ignore','pipe','pipe','ipc']});
      const capture=()=>{let pending='';return bytes=>{pending+=bytes.toString();const lines=pending.split('\n');pending=lines.pop();
        for(const line of lines){try{const data=JSON.parse(line);if(data.event==='startup_failed')phase=data.phase;}catch{}}};};
      child.stderr.on('data',capture());child.stdout.on('data',capture());child.phase=()=>phase;
      child.result=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});children.push(child);return child;};
    const api=launch();let document;
    for(let i=0;i<200&&api.exitCode===null;i++){
      try{const response=await fetch(`http://127.0.0.1:${port}/.well-known/galaxy-network.json`,{signal:AbortSignal.timeout(500)});if(response.ok){document=await response.json();break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.ok(document,'Hub API must serve Manifest; failure phase='+api.phase());
    const verified=await verifyHubManifest(document,{endpoint,trustedKeys:new Map([['service',pin(key,'service')]])});
    assert.equal(verified.data.displayName,hubProfile.displayName);assert.equal(verified.data.operator,env.GALAXY_OPERATOR);assert.equal(verified.data.region,'test');
    assert.equal(verified.connected,false);await assert.rejects(verifyManifest(document,{endpoint,trustedKeys:new Map([['service',pin(key,'service')]])}));
    const row=(await db.query("SELECT * FROM runtime_config_events WHERE component='api' ORDER BY sequence DESC LIMIT 1")).rows[0];
    verifyRuntimeConfigEvent(row);assert.deepEqual(row.payload.snapshot.network,{type:'hub',manifestSha256:hubManifestDigest(verified.data)});
    assert.deepEqual(await stop(api),{code:0,signal:null});
    await writeFile(paths.profile,JSON.stringify({...hubProfile,hub:{...hubProfile.hub,profile:'unsupported/9'}}));
    const invalid=launch(true);assert.deepEqual(await invalid.result,{code:1,signal:null});assert.equal(invalid.phase(),'services');
    assert.equal(Number((await db.query('SELECT count(*) FROM runtime_config_events')).rows[0].count),1);
    console.log(JSON.stringify({event:'hub_runtime_profile_verified',actualApi:true,restrictedRole:true,metadataMatched:true,configurationDigestMatched:true,invalidProfileRejected:true}));
  }finally{
    for(const child of children)await stop(child);
    await db?.end();await admin.end();
    const child=relative(tmpdir(),temporary);assert.ok(child.startsWith('galaxy-hub-process-')&&!isAbsolute(child)&&!child.startsWith('..'));
    await rm(temporary,{recursive:true,force:true});
  }
});
