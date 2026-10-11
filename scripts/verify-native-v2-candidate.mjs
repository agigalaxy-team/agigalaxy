import {readFile,writeFile,mkdtemp,rm,readdir,stat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,generateKeyPairSync} from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex');
export async function verifyNativeCandidate(candidate,pythonExecutable){
 if(!isAbsolute(candidate))throw new Error('Absolute candidate required');
 const manifest=JSON.parse(await readFile(join(candidate,'native-v2.json'),'utf8'));
 for(const[path,expected]of Object.entries(manifest.artifacts))assert.equal(sha(await readFile(join(candidate,path))),expected,'artifact '+path);
 const hashes=JSON.parse(await readFile(join(candidate,'source-hashes.json'),'utf8'));
 for(const[path,expected]of Object.entries(hashes))assert.equal(sha(await readFile(join(root,path))),expected,'source '+path);
 const pkg=JSON.parse(await readFile(join(candidate,'package.json'),'utf8')),lock=JSON.parse(await readFile(join(candidate,'package-lock.json'),'utf8'));
 assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);
 for(const[name,version]of Object.entries(pkg.dependencies))assert.equal(JSON.parse(await readFile(join(candidate,'node_modules',name,'package.json'),'utf8')).version,version);
 const {generateHostConfigs}=await import(pathToFileURL(join(candidate,'host-configs.mjs')));
 const temporary=await mkdtemp(join(tmpdir(),'galaxy-native-config-check-'));
 const actual=resolve(temporary),prefix=resolve(tmpdir())+sep;
 if(!actual.startsWith(prefix)||!actual.split(sep).at(-1).startsWith('galaxy-native-config-check-'))throw new Error('Temporary cleanup target changed');
 try{
  const key=generateKeyPairSync('ed25519'),now=Math.floor(Date.now()/1000),configPath=join(temporary,'synthetic-public-config.json');
  await writeFile(configPath,JSON.stringify({version:2,endpoint:'https://not-connected.example.org',website:'https://www.example.org',dataDirectory:join(temporary,'data'),
   trustedKeys:{synthetic:{publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}),notBefore:now-1,notAfter:now+1000,revoked:false}}}));
  const destination=join(temporary,'generated'),result=await generateHostConfigs({packageDirectory:candidate,configPath,destination});
  assert.equal(result.hostCount,8);assert.equal(result.actualSettingsModified,false);
  // A second invocation cannot replace any pre-existing reviewed output.
  await assert.rejects(generateHostConfigs({packageDirectory:candidate,configPath,destination}),{code:'EEXIST'});
  const commandConfigs=['claude-code/.mcp.json','claude-desktop-chat/claude_desktop_config.fragment.json','codex/galaxy-native-v2/.mcp.json','cursor/.cursor/mcp.json','workbuddy/galaxy-native-v2/mcp.json','trae-work/mcp.local.json'];
  for(const path of commandConfigs){const config=JSON.parse(await readFile(join(destination,path),'utf8')),server=config.mcpServers.galaxy;
   assert.deepEqual(server.args,[join(candidate,'galaxy.js')]);assert.equal(server.env.GALAXY_NATIVE_CONFIG,configPath);
   assert.equal(server.command,path.startsWith('trae')?'node':process.execPath);}
  assert.ok(JSON.parse(await readFile(join(destination,'copilot-vscode/.vscode/mcp.json'),'utf8')).servers.galaxy);
  const dsh=JSON.parse(await readFile(join(destination,'deepseek-harness/mcp-plugin.fragment.json'),'utf8'));assert.equal(dsh.config.transport,'stdio');
  const files=[];async function walk(dir){for(const name of await readdir(dir)){const path=join(dir,name);if((await stat(path)).isDirectory())await walk(path);else files.push(relative(destination,path).split(sep).join('/'));}}await walk(destination);
  const skill=await readFile(join(candidate,'skills/galaxy/SKILL.md'),'utf8');for(const path of files.filter(x=>x.endsWith('/SKILL.md')))assert.equal(await readFile(join(destination,path),'utf8'),skill);
  let syntaxCheck='not-requested';
  if(pythonExecutable){
   assert.ok(isAbsolute(pythonExecutable));const checked=spawnSync(pythonExecutable,['-c',
    'import pathlib,sys,tomllib,yaml,json; p=pathlib.Path(sys.argv[1]); ts=list(p.rglob("*.toml")); ys=list(p.rglob("*.yaml")); [tomllib.loads(f.read_text(encoding="utf-8")) for f in ts]; [yaml.safe_load(f.read_text(encoding="utf-8")) for f in ys]; print(json.dumps({"toml":len(ts),"yaml":len(ys),"passed":True}))',destination],{encoding:'utf8',windowsHide:true});
   assert.equal(checked.status,0,checked.stderr);syntaxCheck=JSON.parse(checked.stdout);
  }
  return{candidate,sourceHashesVerified:Object.keys(hashes).length,jsArtifactsVerified:Object.keys(manifest.artifacts).length,exactDependencies:Object.keys(pkg.dependencies).length,hostCount:8,
   generatedFiles:files.length,sharedSkillCopies:files.filter(x=>x.endsWith('/SKILL.md')).length,existingOutputOverwriteRejected:true,
   actualSettingsModified:false,actualHostAcceptance:false,syntheticConfigurationOnly:true,temporaryDirectoryRemoved:true,syntaxCheck};
 }finally{
  await rm(actual,{recursive:true,force:true});
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await verifyNativeCandidate(process.argv[2],process.argv[3])));
