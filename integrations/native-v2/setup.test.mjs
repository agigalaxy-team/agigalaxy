import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {prepareNativeInstallation,websiteOrigin} from './setup.mjs';
import {installOpenCodeConfiguration} from './host-configs.mjs';
import {prepareOpenCodeLocalWork,deferOpenCodePreparation,isOpenCodePreparationDeferred} from '../host-adapters/opencode-stable/local-preparation.mjs';
import {getLocalSnapshot} from '../../packages/galaxy-core/src/local-store.mjs';
import {createNativeStore} from '../../packages/galaxy-edge-mcp/src/native-v2/store.mjs';

test('one actual installation merges the selected OpenCode profile and prepares local work without an account',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'galaxy-setup-'));
 try{
  const packageDirectory=join(folder,'package'),dataDirectory=join(folder,'existing-user-data'),destination=join(folder,'new-connection'),openCodeConfigDirectory=join(folder,'chosen-opencode');
  await mkdir(packageDirectory);await mkdir(join(packageDirectory,'skills/galaxy'),{recursive:true});await mkdir(dataDirectory);
  await writeFile(join(dataDirectory,'preserved.txt'),'original input');
  for(const[name,bytes]of Object.entries({'galaxy.js':'export {};','opencode.js':'export {};','native-v2.json':JSON.stringify({kind:'galaxy-native-v2-local-candidate'}),'host-capabilities.json':'{}','HOSTS.md':'Install only the selected connection.','skills/galaxy/SKILL.md':'Synthetic test skill'}))await writeFile(join(packageDirectory,name),bytes);
  const now=Math.floor(Date.now()/1000),publicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  const source={version:1,endpoint:'https://selected-api.invalid',operator:'Synthetic installation service',signingKeys:[{kid:'synthetic',publicKeyPem:publicKey,notBefore:now-1,notAfter:now+3600,revoked:false}]};
  let reads=0,reviewed;
  const options={website:'https://selected-site.invalid/downloads/client',host:'opencode',dataDirectory,destination,packageDirectory,openCodePath:process.execPath,openCodeConfigDirectory,initializeLocalWork:prepareOpenCodeLocalWork,
   fetch:async(url,request)=>{reads++;assert.equal(url,'https://selected-site.invalid/galaxy-web-config.json');assert.equal(request.redirect,'error');return Response.json(source);},
   confirm:review=>{reviewed=review;return false;}};
  assert.equal(websiteOrigin(options.website),'https://selected-site.invalid');
  const canceled=await prepareNativeInstallation(options);assert.equal(canceled.canceled,true);await assert.rejects(stat(destination),{code:'ENOENT'});
  await assert.rejects(stat(openCodeConfigDirectory),{code:'ENOENT'});await assert.rejects(stat(join(dataDirectory,'galaxy-id.json')),{code:'ENOENT'});
  const result=await prepareNativeInstallation({...options,confirm:review=>{reviewed=review;source.endpoint='https://later-change.invalid';return true;}});
  assert.equal(reads,2,'Each preparation reads once; the final file uses the service actually reviewed.');
  assert.equal(result.endpoint,'https://selected-api.invalid');assert.equal(reviewed.endpoint,result.endpoint);assert.equal(result.connected,false);assert.equal(result.identityCreated,true);assert.equal(result.actualSettingsModified,true);
  assert.equal(reviewed.hostConfigDirectory,openCodeConfigDirectory);assert.equal(reviewed.subjectType,'person');
  assert.equal(await readFile(join(dataDirectory,'preserved.txt'),'utf8'),'original input');
  const local=await getLocalSnapshot(dataDirectory);assert.equal(local.identity.subjectType,'person');assert.equal(local.state.uploadPrivacy.level,'history-overview');
  const config=JSON.parse(await readFile(result.configPath,'utf8'));assert.equal(config.endpoint,reviewed.endpoint);assert.equal(config.dataDirectory,dataDirectory);assert.equal(config.trustedKeys.synthetic.publicKeyPem,publicKey);
  assert.ok(result.packageDirectory.startsWith(join(openCodeConfigDirectory,'galaxy-native')));assert.equal(await readFile(join(result.packageDirectory,'galaxy.js'),'utf8'),'export {};');
  const mcp=JSON.parse(await readFile(join(result.hostDirectory,'opencode/opencode.json'),'utf8'));assert.deepEqual(mcp.mcp.galaxy.command,[process.execPath,join(result.packageDirectory,'galaxy.js')]);assert.deepEqual(mcp.mcp.galaxy.environment,{GALAXY_NATIVE_CONFIG:result.configPath});assert.equal(mcp.provider,undefined);
  assert.deepEqual(mcp.skills.paths,[join(result.hostDirectory,'opencode/.agents/skills')],'The named Skill is discoverable from the original work directory without writing to that project or the global host profile.');
  const tui=JSON.parse(await readFile(join(result.hostDirectory,'opencode/tui.json'),'utf8'));assert.equal(tui.plugin.length,1);assert.match(tui.plugin[0],/galaxy\.tui\.mjs$/);
  const installedTui=JSON.parse(await readFile(join(openCodeConfigDirectory,'tui.json'),'utf8'));assert.equal(installedTui.plugin.length,1);
  const plugin=await readFile(join(openCodeConfigDirectory,'galaxy-native.tui.mjs'),'utf8');assert.ok(plugin.includes(JSON.stringify(dataDirectory)));assert.ok(plugin.includes(JSON.stringify(result.endpoint)));
  const generated=JSON.parse(await readFile(join(result.hostDirectory,'generated-configs.json'),'utf8'));assert.deepEqual(generated.hosts,['opencode']);assert.equal(generated.hostCount,1);
  await assert.rejects(stat(join(result.hostDirectory,'codex')),{code:'ENOENT'});
  const launcher=await readFile(result.launcher,'utf8');assert.match(launcher,/OPENCODE_CONFIG_DIR/);assert.equal(launcher.includes('OPENCODE_TUI_CONFIG:'),false,'The installed TUI plugin is not loaded a second time through an override.');assert.equal(launcher.includes('shell:true'),false);assert.equal(launcher.includes('provider'),false);assert.equal(launcher.includes('HOME:'),false);
  const original=await readFile(result.configPath,'utf8');await assert.rejects(prepareNativeInstallation({...options,confirm:()=>true}),{code:'EEXIST'});assert.equal(await readFile(result.configPath,'utf8'),original);
 }finally{const target=resolve(folder);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-setup-'));await rm(target,{recursive:true,force:true});}
});

test('a chosen profile keeps JSONC comments, unrelated plugins and project settings across installation updates',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'galaxy-setup-merge-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const directory=join(folder,'chosen-profile'),project=join(folder,'project'),dataDirectory=join(folder,'local-data');
 await mkdir(directory);await mkdir(project);const projectFile=join(project,'opencode.json');await writeFile(projectFile,'{"model":"project-provider/model"}\n');
 const existing='// Keep the provider and its formatting.\n{\n  "provider": {"my-provider": {"options": {"baseURL": "http://127.0.0.1:1"}}},\n  "mcp": {"other-tool": {"type":"local", "command":["other"]}},\n  "skills": {"paths": ["other-skills"]},\n}\n';
 await writeFile(join(directory,'opencode.jsonc'),existing);
 await writeFile(join(directory,'tui.json'),'// Keep other plugins.\n{"theme":"original", "plugin":["unrelated-plugin", ["configured-plugin", {"option":"unchanged"}]],}\n');
 const options={directory,packageDirectory:join(folder,'package-v1'),configPath:join(folder,'public-v1.json'),dataDirectory,endpoint:'https://service.invalid',nodePath:process.execPath};
 await installOpenCodeConfiguration(options);
 const once=await readFile(join(directory,'opencode.jsonc'),'utf8');assert.ok(once.startsWith('// Keep the provider'));assert.ok(once.includes('"provider": {"my-provider": {"options": {"baseURL": "http://127.0.0.1:1"}}}'));assert.ok(once.includes('"other-tool"'));assert.ok(once.includes('other-skills'));
 await installOpenCodeConfiguration({...options,packageDirectory:join(folder,'package-v2'),configPath:join(folder,'public-v2.json')});
 const tui=await readFile(join(directory,'tui.json'),'utf8');assert.ok(tui.startsWith('// Keep other plugins.'));
 // Strip fixture comments/trailing comma only for assertion, not for rewriting.
 const selected=JSON.parse(tui.replace(/^\/\/.*\n/,'').replace(/,\s*}/g,'}'));
 assert.equal(selected.theme,'original');assert.equal(selected.plugin.filter(item=>typeof item==='string'&&item.includes('galaxy-native.tui.mjs')).length,1);
 assert.deepEqual(selected.plugin.slice(0,2),['unrelated-plugin',['configured-plugin',{option:'unchanged'}]]);
 assert.equal(await readFile(projectFile,'utf8'),'{"model":"project-provider/model"}\n');
 assert.equal((await readFile(join(directory,'galaxy-native.tui.mjs'),'utf8')).includes('package-v2'),true);
});

test('local installation preserves existing identity and a declined start never creates one',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'galaxy-setup-identity-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const declined=join(folder,'declined');await deferOpenCodePreparation(declined);
 assert.equal(await isOpenCodePreparationDeferred(declined),true);assert.equal((await getLocalSnapshot(declined)).identity,null);
 const first=await prepareOpenCodeLocalWork(folder,{subjectType:'organization'}),before=await getLocalSnapshot(folder);
 const second=await prepareOpenCodeLocalWork(folder,{subjectType:'person'}),after=await getLocalSnapshot(folder);
 assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(second.identity,first.identity);assert.equal(after.identity.subjectType,'organization');assert.deepEqual(after.identity,before.identity);
 const adopted=join(folder,'adopted'),endpoint='https://existing-service.invalid',selected='3343ef91-8dbf-40af-8e9c-4f04561c154a';
 await createNativeStore(adopted).updateConnection(endpoint,current=>({...current,active:{subjectId:selected}}));
 const kept=await prepareOpenCodeLocalWork(adopted,{subjectType:'person',endpoint});assert.equal(kept.identity,selected);assert.equal(kept.created,false);assert.equal((await getLocalSnapshot(adopted)).identity,null);
});
