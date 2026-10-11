import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm} from 'node:fs/promises';
import {join,resolve,sep,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const json=x=>JSON.stringify(x,null,2)+'\n';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function galaxySkillDiscovery(response,cwd){
 const data=!response?.error&&Array.isArray(response?.result?.data)?response.result.data:null;
 const expectedPath=typeof cwd==='string'&&isAbsolute(cwd)?resolve(cwd,'.agents/skills/galaxy/SKILL.md'):null;
 const samePath=(value,expected)=>typeof value==='string'&&isAbsolute(value)&&resolve(value)===expected;
 // A response cwd can itself contain "galaxy". Only the requested workspace's
 // exact named Skill at the copied absolute path proves candidate discovery.
 const evidence=expectedPath&&data?data.flatMap(row=>samePath(row?.cwd,resolve(cwd))&&Array.isArray(row?.skills)
  ?row.skills.filter(skill=>skill?.name==='galaxy'&&samePath(skill.path,expectedPath))
   .map(skill=>({name:skill.name,path:skill.path,expectedPath})) :[]):[];
 return{skillsListed:data!==null,galaxySkillFound:evidence.length>0,galaxySkillEvidence:evidence};
}
function environment(directory){
 const env={};for(const name of ['PATH','Path','SystemRoot','SYSTEMROOT','ComSpec','COMSPEC','PATHEXT','WINDIR'])if(process.env[name])env[name]=process.env[name];
 // These are child-process configuration selectors, never exports or changes to
 // the caller's HOME/CODEX_HOME or user settings. No provider/auth env is copied.
 return{...env,TEMP:directory,TMP:directory,USERPROFILE:join(directory,'profile'),APPDATA:join(directory,'appdata'),LOCALAPPDATA:join(directory,'localappdata'),
  CODEX_HOME:join(directory,'codex-profile'),CLAUDE_CONFIG_DIR:join(directory,'claude-profile'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_SKIP_PROMPT_HISTORY:'1',DISABLE_AUTOUPDATER:'1'};
}
async function stop(child){if(!child||child.exitCode!==null)return;child.stdin?.end();await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);
 if(child.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);}}
async function trace(path){try{return(await readFile(path,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));}catch{return[];}}
function rpc(child){
 let id=0,buffer='';const pending=new Map();child.stdout.on('data',c=>{buffer+=c;for(;;){const end=buffer.indexOf('\n');if(end<0)break;
  const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;let item;try{item=JSON.parse(line);}catch{continue;}
  const p=pending.get(item.id);if(p){pending.delete(item.id);clearTimeout(p.timer);p.resolve(item);}}});
 const request=(method,params)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(new Error('Installed host request timed out: '+method));},25000);
  pending.set(key,{resolve,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});
 return{request,notify:(method,params={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n')};
}
export async function probeInstalledHosts({candidate,codexEntry,claudeExecutable,reportFile}){
 for(const p of[candidate,codexEntry,claudeExecutable,reportFile])if(!isAbsolute(p))throw new Error('Explicit absolute candidate, installed CLI and new report paths required');
 const directory=await mkdtemp(join(tmpdir(),'galaxy-installed-host-probe-'));let codex;
 const target=resolve(directory);
 if(!target.startsWith(resolve(tmpdir())+sep)||!target.split(sep).at(-1).startsWith('galaxy-installed-host-probe-'))throw new Error('Host probe cleanup target changed');
 const codexRun=codexEntry.endsWith('.exe')?{file:codexEntry,args:[]}:{file:process.execPath,args:[codexEntry]};
 const report={version:1,candidate,startedAt:new Date().toISOString(),syntheticConfiguration:true,userLoginRead:false,userModelCalls:0,globalConfigurationChanged:false,desktopUiVerified:false,hosts:[]};
 try{
  const env=environment(directory);for(const path of[directory,env.USERPROFILE,env.APPDATA,env.LOCALAPPDATA,env.CODEX_HOME,env.CLAUDE_CONFIG_DIR])await mkdir(path,{recursive:true});
  const cwd=join(directory,'workspace');await mkdir(cwd);await cp(join(candidate,'skills/galaxy'),join(cwd,'.agents/skills/galaxy'),{recursive:true});
  const now=Math.floor(Date.now()/1000),pair=generateKeyPairSync('ed25519'),configPath=join(directory,'synthetic-public-config.json');
  await writeFile(configPath,json({version:2,endpoint:'https://not-connected.example.org',website:'https://www.example.org',dataDirectory:join(directory,'data'),
   trustedKeys:{synthetic:{publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),notBefore:now-1,notAfter:now+1000,revoked:false}}}));
  // This is a byte-forwarding recorder, not an MCP client. Only the installed
  // host originates initialize/tools/list. Record method names and result counts,
  // never tool arguments, text, keys or credentials.
  const proxy=join(directory,'forward.mjs');
  await writeFile(proxy,`import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';const[entry,log]=process.argv.slice(2),child=spawn(process.execPath,[entry],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:process.env}),requests=new Map();let input='',output='';function record(v){appendFileSync(log,JSON.stringify(v)+'\\n');}process.stdin.on('data',chunk=>{child.stdin.write(chunk);input+=chunk;for(;;){const p=input.indexOf('\\n');if(p<0)break;const line=input.slice(0,p);input=input.slice(p+1);try{const m=JSON.parse(line);if(m.method){record({direction:'host-to-server',method:m.method});requests.set(m.id,m.method);}}catch{}}});child.stdout.on('data',chunk=>{process.stdout.write(chunk);output+=chunk;for(;;){const p=output.indexOf('\\n');if(p<0)break;const line=output.slice(0,p);output=output.slice(p+1);try{const m=JSON.parse(line),method=requests.get(m.id);if(method)record({direction:'server-to-host',method,error:m.error?.code??null,...(Array.isArray(m.result?.tools)?{toolCount:m.result.tools.length}:{}),...(m.result?.serverInfo?{serverName:m.result.serverInfo.name}: {})});}catch{}}});process.stdin.on('end',()=>child.stdin.end());child.stderr.on('data',c=>process.stderr.write(c));child.on('exit',code=>process.exit(code??1));process.on('SIGTERM',()=>{child.kill();process.exit(0)});`);
  const codexTrace=join(directory,'codex-trace.jsonl'),args=[proxy,join(candidate,'galaxy.js'),codexTrace];
  const toml='[analytics]\nenabled = false\n[mcp_servers.galaxy]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = '+JSON.stringify(args)+'\nstartup_timeout_sec = 20\n[mcp_servers.galaxy.env]\nGALAXY_NATIVE_CONFIG = '+JSON.stringify(configPath)+'\n';
  await writeFile(join(env.CODEX_HOME,'config.toml'),toml);
  const version=execFileSync(codexRun.file,[...codexRun.args,'--version'],{env,cwd,windowsHide:true,encoding:'utf8',timeout:15000}).trim();
  codex=spawn(codexRun.file,[...codexRun.args,'app-server','--stdio'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let errors='';codex.stderr.on('data',c=>{errors+=c;});
  const channel=rpc(codex),initialized=await channel.request('initialize',{clientInfo:{name:'galaxy-installed-native-probe',title:'Synthetic local MCP discovery',version:'1'},capabilities:{experimentalApi:true}});
  if(initialized.error)throw new Error('Codex initialize rejected '+initialized.error.code);channel.notify('initialized');
  const status=await channel.request('mcpServerStatus/list',{limit:100,detail:'toolsAndAuthOnly'});
  const skills=await channel.request('skills/list',{cwds:[cwd],forceReload:true});
  const server=status.result?.data?.find(x=>x.name==='galaxy'),events=await trace(codexTrace);
  report.hosts.push({host:'Codex CLI app-server',version,rpcError:status.error?.code??null,serverPresent:!!server,
   toolCount:server?.tools?Object.keys(server.tools).length:0,events,...galaxySkillDiscovery(skills,cwd),modelTurnStarted:false});
  await stop(codex);codex=null;
  const claudeTrace=join(directory,'claude-trace.jsonl'),mcpArgs=[proxy,join(candidate,'galaxy.js'),claudeTrace],claudeVersion=execFileSync(claudeExecutable,['--version'],{env,cwd,windowsHide:true,encoding:'utf8',timeout:15000}).trim();
  // Explicit installed CLI writes only this empty temporary profile.
  execFileSync(claudeExecutable,['mcp','add','galaxy','--scope','user','--transport','stdio','--env','GALAXY_NATIVE_CONFIG='+configPath,'--',process.execPath,...mcpArgs],
   {env,cwd,windowsHide:true,encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
  let result='',healthError=null;
  try{result=execFileSync(claudeExecutable,['mcp','get','galaxy'],{env,cwd,windowsHide:true,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});}
  catch(e){result=String(e.stdout??'');healthError={code:e.code??null,status:e.status??null,signal:e.signal??null};}
  const claudeEvents=await trace(claudeTrace);
  report.hosts.push({host:'Claude Code CLI',version:claudeVersion,healthError,healthConnected:/Connected/.test(result),events:claudeEvents,toolDiscovery:claudeEvents.some(e=>e.method==='tools/list'&&e.toolCount>0),modelTurnStarted:false});
  report.completedAt=new Date().toISOString();
 }catch(e){report.probeError={message:String(e.message).split('\n')[0],code:e.code??null,stderr:String(e.stderr??'').slice(0,1500)};
 }finally{
  await stop(codex);
  try{await rm(target,{recursive:true,force:true,maxRetries:20,retryDelay:300});report.temporaryProfileRemoved=true;}
  catch(e){report.temporaryProfileRemoved=false;report.cleanupPending={directory:target,code:e.code};}
 }
 await writeFile(reportFile,json(report),{flag:'wx'});return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await probeInstalledHosts({candidate:process.argv[2],codexEntry:process.argv[3],claudeExecutable:process.argv[4],reportFile:process.argv[5]})));
