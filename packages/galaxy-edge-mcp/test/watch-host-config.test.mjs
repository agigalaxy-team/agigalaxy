import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createConfiguredWatchHost,nativeWatchHostConfigSchema} from '../src/native-v2/watch-host-config.mjs';
import {createClaudeCodeDriver} from '../src/native-v2/host-adapters/claude-code.mjs';

const config={kind:'claude-code',command:process.execPath,cwd:process.cwd()};
const help=' --bare --restricted --safe-mode --tools --disallowedTools --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands --no-chrome --permission-mode --permission-prompts --no-session-persistence --session-id --replay-user-messages ';
const work=()=>({watchId:randomUUID(),work:{workId:randomUUID(),roomId:randomUUID(),items:[{messageId:randomUUID(),sequence:'1',text:'Synthetic authorized room body'}]},
 purpose:'only this explicit scope',model:'chosen-model',cwd:process.cwd(),scopeKey:'synthetic-binding/grant'});

test('formal Claude config permits only trusted local command/cwd, never a reader assertion or extra executable settings',()=>{
 assert.deepEqual(nativeWatchHostConfigSchema.parse(config),config);
 for(const addition of [{args:['--unsafe']},{env:{ANTHROPIC_API_KEY:'synthetic'}},{readerConfigurationConfirmed:true},{verifyReaderProfile:true},{readerVerifier:{command:process.execPath}},{disabledMcpServers:['x']}]){
  assert.equal(nativeWatchHostConfigSchema.safeParse({...config,...addition}).success,false);
 }
 assert.equal(nativeWatchHostConfigSchema.safeParse({...config,command:'claude'}).success,false);
 assert.equal(nativeWatchHostConfigSchema.safeParse({...config,cwd:'relative'}).success,false);
 assert.equal(nativeWatchHostConfigSchema.safeParse({...config,kind:'unknown-host'}).success,false);
});

test('default production factory creates the actual Claude driver and a non-Claude executable cannot pass help evidence',async()=>{
 const configured=createConfiguredWatchHost(config),driver=configured.createDriver();
 try{
  const caps=await driver.capabilities();
  assert.equal(caps.host,'claude-code');assert.equal(caps.readerProfileDocumented,false);
  assert.equal(caps.backgroundReaderSupported,false);assert.equal(caps.readerConfigurationConfirmed,false);
  const result=await driver.run(work());assert.equal(result.reason,'host_reader_profile_unavailable');
  assert.equal(result.hostTurnDispatches,0);assert.equal(result.foregroundFallback,true);
 }finally{await driver.close();}
});

test('formal factory with the actual Claude driver declares managed-policy evidence unavailable and dispatches no prompt',async()=>{
 const probes=[],constructors=[];let turnSpawns=0,journals=0;
 const configured=createConfiguredWatchHost(config,{createDriver:options=>{
  constructors.push(options);return createClaudeCodeDriver({...options,
   readCommand:async args=>{probes.push(args);return args[0]==='--version'?'2.1.266 (Claude Code)':help;},
   spawnProcess:()=>{turnSpawns++;throw Error('Must not spawn a model process');}});
 }}),driver=configured.createDriver();
 try{
  assert.deepEqual(constructors,[{command:config.command,cwd:config.cwd}]);
  const caps=await driver.capabilities();assert.equal(caps.readerProfileDocumented,true);
  assert.equal(caps.readerConfigurationEvidence,'version-help-only');assert.equal(caps.effectiveManagedPolicyConfirmed,false);
  assert.equal(caps.backgroundReaderSupported,false);assert.equal(caps.backgroundReaderReason,'host_reader_configuration_unconfirmed');
  const result=await driver.run({...work(),onState:async()=>{journals++;}});
  assert.equal(result.state,'failed');assert.equal(result.reason,'host_reader_configuration_unconfirmed');
  assert.equal(result.foregroundFallback,true);assert.equal(result.hostTurnDispatches,0);assert.equal(result.output,undefined);
  assert.equal(journals,0);assert.equal(turnSpawns,0);assert.deepEqual(probes,[['--version'],['--help']]);
  const before=probes.length,receipt=await driver.reconcile({threadId:randomUUID(),turnId:randomUUID()});
  assert.equal(receipt.state,'unknown');assert.equal(receipt.bodyIncluded,false);assert.equal(turnSpawns,0);assert.equal(probes.length,before);
 }finally{await driver.close();}
});

test('adding Claude leaves the existing trusted Codex constructor payload and disabled server options intact',()=>{
 const calls=[],codex={kind:'codex-app-server',command:process.execPath,cwd:process.cwd(),disabledMcpServers:['server']};
 const configured=createConfiguredWatchHost(codex,{createDriver:options=>{calls.push(options);return{synthetic:true};}});
 assert.deepEqual(configured.createDriver(),{synthetic:true});assert.deepEqual(calls,[{command:codex.command,cwd:codex.cwd,disabledMcpServers:['server']}]);
 assert.equal(createConfiguredWatchHost(null),null);assert.equal(createConfiguredWatchHost(undefined),null);
});
