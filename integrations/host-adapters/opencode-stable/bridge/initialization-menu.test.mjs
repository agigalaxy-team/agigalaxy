import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {generateKeyPairSync,createPrivateKey,createPublicKey} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createGalaxyAdapter} from '../galaxy.tui.ts';
import {createHostLocalClient} from './host-local-client.mjs';
import {verifyGalaxyGenesis} from '../../../../packages/galaxy-contracts/src/identity/galaxy-guid.mjs';
const executable=process.env.GALAXY_GO_TEST_BINARY;
async function eventually(predicate){for(let index=0;index<150;index++){if(await predicate())return;await delay(20);}assert.fail('Actual host initialization did not finish');}
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'galaxy-go-start-')),configPath=join(directory,'native.json'),dataDirectory=join(directory,'configured-data'),wrongDirectory=join(directory,'unused-host-default');
 const now=Math.floor(Date.now()/1000),key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
 await writeFile(configPath,JSON.stringify({version:2,website:'https://selected.invalid',endpoint:'https://galaxy.invalid',dataDirectory,trustedKeys:{synthetic:{publicKeyPem:key,notBefore:now-1,notAfter:now+3600,revoked:false}}}));
 const host=createHostLocalClient({executable,configPath});let adapter,page,cleanup,selects=0,toolCalls=0;
 const commands=new Map(),api={keymap:{registerLayer:({commands:entries})=>{for(const command of entries)commands.set(command.name,command);return()=>{for(const command of entries)if(commands.get(command.name)===command)commands.delete(command.name);};}},ui:{dialog:{setSize(){},clear(){const old=cleanup;cleanup=null;page=null;old?.();},replace(render,onClose){const old=cleanup;cleanup=onClose;old?.();page=render();}},DialogSelect:props=>{selects++;return{kind:'select',...props};},DialogAlert:props=>({kind:'alert',...props}),DialogPrompt:props=>({kind:'prompt',...props}),toast(){}}};
 t.after(async()=>{await adapter?.close();await host.close();const exact=resolve(directory);assert.ok(exact.startsWith(resolve(tmpdir())+sep));await rm(exact,{recursive:true,force:true});});
 adapter=createGalaxyAdapter(null,{dataDirectory:wrongDirectory,hostPersistence:host,nativeTools:{call:async()=>{toolCalls++;throw Error('MCP must not confirm this host-menu choice again');}}});
 await adapter.tui(api);
 return{host,dataDirectory,wrongDirectory,commands,get page(){return page;},get selects(){return selects;},get toolCalls(){return toolCalls;},choose(value){const option=page?.options?.find(item=>item.value===value);assert.ok(option,'missing original menu choice '+value);option.onSelect();}};
}
for(const [choice,subjectType]of [['1','person'],['2','organization']])test('actual '+subjectType+' first-start menu creates Go identity once in the configured directory',{skip:!executable&&'Set GALAXY_GO_TEST_BINARY to the development Go executable'},async t=>{
 const f=await fixture(t);assert.match(f.page.title,/开始使用银河/);await assert.rejects(stat(f.dataDirectory),{code:'ENOENT'});await assert.rejects(stat(f.wrongDirectory),{code:'ENOENT'});
 f.choose(choice);await eventually(async()=>!!(await f.host.history.identity()));await eventually(()=>f.page===null);
 const identity=JSON.parse(await readFile(join(f.dataDirectory,'galaxy-id.json'),'utf8'));assert.equal(identity.subjectType,subjectType);assert.equal(identity.clientKind,'normal');assert.equal(verifyGalaxyGenesis(identity.id,identity.genesisProof),true);
 const publicKey=await readFile(join(f.dataDirectory,'galaxy-id-public-key.pem'),'utf8'),privateKey=await readFile(join(f.dataDirectory,'galaxy-id-private-key.pem'),'utf8');assert.equal(createPublicKey(createPrivateKey(privateKey)).export({type:'spki',format:'pem'}),publicKey);
 assert.equal((await f.host.preparationStatus()).deferred,false);assert.equal(f.selects,1,'The original actual choice is sufficient; no second confirmation is opened');assert.equal(f.toolCalls,0);await assert.rejects(stat(f.wrongDirectory),{code:'ENOENT'});
 const state=JSON.parse(await readFile(join(f.dataDirectory,'galaxy-local-state.json'),'utf8'));assert.equal(state.integration.modules.length,5);assert.equal(state.uploadPrivacy.level,'history-overview');assert.equal(state.auditEvents.filter(item=>item.action==='galaxy_id.initialized').length,1);
});
test('actual first-start later choice saves only the original deferred preference under Go config',{skip:!executable&&'Set GALAXY_GO_TEST_BINARY to the development Go executable'},async t=>{
 const f=await fixture(t);f.choose('3');await eventually(async()=>(await f.host.preparationStatus()).deferred);await eventually(()=>f.page===null);
 assert.deepEqual(JSON.parse(await readFile(join(f.dataDirectory,'opencode-local-preparation.json'),'utf8')),{version:1,deferred:true});await assert.rejects(stat(join(f.dataDirectory,'galaxy-id.json')),{code:'ENOENT'});await assert.rejects(stat(f.wrongDirectory),{code:'ENOENT'});assert.equal(f.toolCalls,0);
});
