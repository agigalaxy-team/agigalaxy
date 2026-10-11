import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {prepareNativeInstallation,websiteOrigin} from './setup.mjs';

test('ordinary preparation reviews the exact public service once and emits only the selected OpenCode connection',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'galaxy-setup-'));
 try{
  const packageDirectory=join(folder,'package'),dataDirectory=join(folder,'existing-user-data'),destination=join(folder,'new-connection');
  await mkdir(packageDirectory);await mkdir(join(packageDirectory,'skills/galaxy'),{recursive:true});await mkdir(dataDirectory);
  await writeFile(join(dataDirectory,'preserved.txt'),'original input');
  for(const[name,bytes]of Object.entries({'galaxy.js':'export {};','opencode.js':'export {};','native-v2.json':JSON.stringify({kind:'galaxy-native-v2-local-candidate'}),'host-capabilities.json':'{}','HOSTS.md':'Install only the selected connection.','skills/galaxy/SKILL.md':'Synthetic test skill'}))await writeFile(join(packageDirectory,name),bytes);
  const now=Math.floor(Date.now()/1000),publicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
  const source={version:1,endpoint:'https://selected-api.invalid',operator:'Synthetic installation service',signingKeys:[{kid:'synthetic',publicKeyPem:publicKey,notBefore:now-1,notAfter:now+3600,revoked:false}]};
  let reads=0,reviewed;
  const options={website:'https://selected-site.invalid/downloads/client',host:'opencode',dataDirectory,destination,packageDirectory,openCodePath:process.execPath,
   fetch:async(url,request)=>{reads++;assert.equal(url,'https://selected-site.invalid/galaxy-web-config.json');assert.equal(request.redirect,'error');return Response.json(source);},
   confirm:review=>{reviewed=review;return false;}};
  assert.equal(websiteOrigin(options.website),'https://selected-site.invalid');
  const canceled=await prepareNativeInstallation(options);assert.equal(canceled.canceled,true);await assert.rejects(stat(destination),{code:'ENOENT'});
  const result=await prepareNativeInstallation({...options,confirm:review=>{reviewed=review;source.endpoint='https://later-change.invalid';return true;}});
  assert.equal(reads,2,'Each preparation reads once; the final file uses the service actually reviewed.');
  assert.equal(result.endpoint,'https://selected-api.invalid');assert.equal(reviewed.endpoint,result.endpoint);assert.equal(result.connected,false);assert.equal(result.identityCreated,false);assert.equal(result.actualSettingsModified,false);
  assert.equal(await readFile(join(dataDirectory,'preserved.txt'),'utf8'),'original input');await assert.rejects(stat(join(dataDirectory,'galaxy-id.json')),{code:'ENOENT'});
  const config=JSON.parse(await readFile(result.configPath,'utf8'));assert.equal(config.endpoint,reviewed.endpoint);assert.equal(config.dataDirectory,dataDirectory);assert.equal(config.trustedKeys.synthetic.publicKeyPem,publicKey);
  const mcp=JSON.parse(await readFile(join(result.hostDirectory,'opencode/opencode.json'),'utf8'));assert.deepEqual(mcp.mcp.galaxy.command,[process.execPath,join(packageDirectory,'galaxy.js')]);assert.deepEqual(mcp.mcp.galaxy.environment,{GALAXY_NATIVE_CONFIG:result.configPath});assert.equal(mcp.provider,undefined);
  assert.deepEqual(mcp.skills.paths,[join(result.hostDirectory,'opencode/.agents/skills')],'The named Skill is discoverable from the original work directory without writing to that project or the global host profile.');
  const tui=JSON.parse(await readFile(join(result.hostDirectory,'opencode/tui.json'),'utf8'));assert.equal(tui.plugin.length,1);assert.match(tui.plugin[0],/galaxy\.tui\.mjs$/);
  const generated=JSON.parse(await readFile(join(result.hostDirectory,'generated-configs.json'),'utf8'));assert.deepEqual(generated.hosts,['opencode']);assert.equal(generated.hostCount,1);
  await assert.rejects(stat(join(result.hostDirectory,'codex')),{code:'ENOENT'});
  const launcher=await readFile(result.launcher,'utf8');assert.match(launcher,/OPENCODE_CONFIG/);assert.match(launcher,/OPENCODE_TUI_CONFIG/);assert.equal(launcher.includes('shell:true'),false);assert.equal(launcher.includes('provider'),false);assert.equal(launcher.includes('HOME:'),false);
  const original=await readFile(result.configPath,'utf8');await assert.rejects(prepareNativeInstallation({...options,confirm:()=>true}),{code:'EEXIST'});assert.equal(await readFile(result.configPath,'utf8'),original);
 }finally{const target=resolve(folder);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-setup-'));await rm(target,{recursive:true,force:true});}
});
