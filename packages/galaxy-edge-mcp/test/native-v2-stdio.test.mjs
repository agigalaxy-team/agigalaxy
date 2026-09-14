import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
const candidate=process.env.GALAXY_NATIVE_TEST_CANDIDATE;
for(const mode of ['2025-11-25','2026-07-28','browser-fallback'])test('real independent stdio '+mode+': actual user choice, local persistence and no silent connection',async()=>{
 const protocol=mode==='browser-fallback'?'2025-11-25':mode,capabilities=mode==='browser-fallback'?{}:{elicitation:{form:{}}};
 const dir=await mkdtemp(join(tmpdir(),'galaxy-native-stdio-'));let child;
 try{const dataDirectory=join(dir,'data'),now=Math.floor(Date.now()/1000),keys=generateKeyPairSync('ed25519');
  const config={version:2,endpoint:'https://not-connected.example.org',website:'https://www.example.org',dataDirectory,
   trustedKeys:{synthetic:{publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}),notBefore:now-10,notAfter:now+1000,revoked:false}}};
  if(mode==='browser-fallback')config.a2a={peers:[{id:'synthetic-peer',endpoint:'https://peer.example/a2a',peerPrincipal:'synthetic',agentCard:{},cardHash:'a'.repeat(64),trustExpiresAt:Date.now()+60000}]};
  const configPath=join(dir,'public-config.json');await writeFile(configPath,JSON.stringify(config));
  const entry=candidate?join(candidate,'galaxy.js'):resolve('packages/galaxy-edge-mcp/src/native-v2-entry.mjs');
  child=spawn(process.execPath,[entry],{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,GALAXY_NATIVE_CONFIG:configPath}});
  let sequence=0,buffer='',stderr='',elicited=0,accepted=false,reviewUrl;const pending=new Map();
  child.stderr.on('data',b=>stderr+=b);const write=value=>child.stdin.write(JSON.stringify(value)+'\n');
  child.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const index=buffer.indexOf('\n');if(index<0)break;const raw=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!raw.trim())continue;
   const message=JSON.parse(raw);if(message.method?.startsWith('elicitation/')){elicited++;write({jsonrpc:'2.0',id:message.id,result:{action:accepted?'accept':'decline',...(accepted?{content:{confirm:true}}:{})}});}
   else if(pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timeout);item.resolve(message);}}});
  const modern=protocol==='2026-07-28',meta={'io.modelcontextprotocol/protocolVersion':protocol,'io.modelcontextprotocol/clientInfo':{name:'synthetic-user-host',version:'1'},'io.modelcontextprotocol/clientCapabilities':capabilities};
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,timeout:setTimeout(()=>reject(new Error('stdio timeout: '+stderr)),8000)});write({jsonrpc:'2.0',id,method,params:{...params,...(modern?{_meta:meta}:{})}});});
  if(!modern){const initialized=await request('initialize',{protocolVersion:protocol,capabilities,clientInfo:{name:'synthetic-user-host',version:'1'}});
   assert.equal(initialized.result.serverInfo.name,'galaxy-native-v2');write({jsonrpc:'2.0',method:'notifications/initialized'});}
  const tools=await request('tools/list',{});for(const name of ['galaxy_task_v2_create','galaxy_context_v2_grant','galaxy_watch_stop','galaxy_summary_local_save','galaxy_device_accept','galaxy_chat_agent_grant','galaxy_help_return'])assert.ok(tools.result.tools.some(t=>t.name===name));
  assert.equal(tools.result.tools.filter(t=>t.name.startsWith('galaxy_a2a_')).length,mode==='browser-fallback'?5:0);
  for(const name of ['galaxy_configuration_v2_read','galaxy_attachment_read'])assert.ok(tools.result.tools.some(t=>t.name===name),name);
  if(mode==='browser-fallback'){
   const listed=await request('tools/call',{name:'galaxy_a2a_peers',arguments:{}});
   const peers=JSON.parse(listed.result.content[0].text);assert.equal(peers[0].id,'synthetic-peer');
   assert.ok(!JSON.stringify(peers).includes('authentication'));assert.ok(!JSON.stringify(peers).includes('credential'));
  }
  const call=async(name,args={})=>{let reply=await request('tools/call',{name,arguments:args});assert.ok(!reply.error,JSON.stringify(reply.error));
   if(reply.result.resultType==='input_required'){assert.ok(modern);elicited++;assert.ok(reply.result.requestState);
    const changed=await request('tools/call',{name,arguments:{profile:'minimal'},requestState:reply.result.requestState,inputResponses:{choice:{action:'accept',content:{confirm:true}}}});
    assert.ok(changed.error||changed.result?.isError,'changed payload cannot consume original choice');
    reply=await request('tools/call',{name,arguments:args,
    requestState:reply.result.requestState,inputResponses:{choice:{action:accepted?'accept':'decline',...(accepted?{content:{confirm:true}}:{})}}});assert.ok(!reply.error,JSON.stringify(reply.error));}
   let result=JSON.parse(reply.result.content[0].text);
   if(result.state==='user-choice-needs-browser'){
    elicited++;reviewUrl=result.url;const page=await fetch(reviewUrl);assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes('银河 · 本机操作审阅'));assert.ok(!html.includes('PRIVATE KEY'));
    const blocked=await fetch(reviewUrl,{method:'POST',headers:{origin:'https://foreign.example','content-type':'application/x-www-form-urlencoded'},body:'action=allow'});assert.equal(blocked.status,403);
    const choice=await fetch(reviewUrl,{method:'POST',headers:{origin:new URL(reviewUrl).origin,'content-type':'application/x-www-form-urlencoded'},body:'action='+(accepted?'allow':'decline')});assert.equal(choice.status,200);
    reply=await request('tools/call',{name,arguments:args});result=JSON.parse(reply.result.content[0].text);
   }
   return result;};
  const before=await call('galaxy_native_status');assert.equal(before.connected,false);await assert.rejects(stat(dataDirectory),{code:'ENOENT'});
  const declined=await call('galaxy_native_initialize',{profile:'coding-case'});assert.equal(declined.state,'declined');await assert.rejects(stat(dataDirectory),{code:'ENOENT'});
  accepted=true;const result=await call('galaxy_native_initialize',{profile:mode==='browser-fallback'?'agent-workspace':'coding-case'});assert.equal(result.localOnly,true);assert.equal(elicited,2);
  const identity=JSON.parse(await readFile(join(dataDirectory,'galaxy-id.json'),'utf8'));assert.equal(identity.id,result.identity);
  const status=await call('galaxy_native_status');assert.equal(status.connected,false);assert.equal(status.modelService,'user-host');assert.ok(!JSON.stringify(status).includes('PRIVATE KEY'));
  child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));child=null;
  if(reviewUrl)await assert.rejects(fetch(reviewUrl),'stdio exit destroys temporary approval surface');
 }finally{if(child){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await rm(dir,{recursive:true,force:true});}
});
