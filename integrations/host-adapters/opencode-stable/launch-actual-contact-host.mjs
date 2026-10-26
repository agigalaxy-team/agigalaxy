import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const argument=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
const executable=argument('executable');
assert.ok(typeof executable==='string'&&isAbsolute(executable),'Explicit --executable=<installed OpenCode absolute path> is required.');
assert.equal((await stat(executable)).isFile(),true);
const bridge=new URL(argument('bridge')),report=resolve(argument('report'));
assert.equal(bridge.protocol,'http:');assert.equal(bridge.hostname,'127.0.0.1');assert.ok(bridge.port);assert.equal(bridge.pathname,'/');
const scratch=await mkdtemp(join(tmpdir(),'galaxy-opencode-contact-')),here=dirname(fileURLToPath(import.meta.url));
const folders={project:join(scratch,'project'),config:join(scratch,'config'),data:join(scratch,'data'),state:join(scratch,'state'),cache:join(scratch,'cache'),temp:join(scratch,'temp')};
await Promise.all(Object.values(folders).map(path=>mkdir(path,{recursive:true})));await mkdir(dirname(report),{recursive:true});
const config=join(folders.config,'opencode','opencode.json'),tui=join(scratch,'tui.json');await mkdir(dirname(config),{recursive:true});
await writeFile(config,JSON.stringify({$schema:'https://opencode.ai/config.json',autoupdate:false,share:'disabled',enabled_providers:[],plugin:[],mcp:{},permission:'deny'}));
await writeFile(tui,JSON.stringify({plugin:['actual-contact-host.tui.mjs','actual-contact-host-probe.mjs'].map(name=>pathToFileURL(join(here,name)).href)}));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['systemroot','windir','comspec','pathext','path'].includes(key.toLowerCase())));
Object.assign(env,{HOME:scratch,USERPROFILE:scratch,APPDATA:folders.config,LOCALAPPDATA:folders.data,TEMP:folders.temp,TMP:folders.temp,
 XDG_CONFIG_HOME:folders.config,XDG_DATA_HOME:folders.data,XDG_STATE_HOME:folders.state,XDG_CACHE_HOME:folders.cache,
 OPENCODE_TEST_HOME:scratch,OPENCODE_CONFIG:config,OPENCODE_CONFIG_DIR:dirname(config),OPENCODE_TUI_CONFIG:tui,OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',
 OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_TERMINAL_TITLE:'1',OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER:'1',TERM:'xterm-256color',
 GALAXY_CONTACT_FIXTURE_URL:bridge.href,GALAXY_HOST_CHECK_REPORT:report,GALAXY_DATA_DIR:join(scratch,'unused-host-identity')});
await writeFile(join(dirname(report),'actual-host-isolation.json'),JSON.stringify({recordedAt:new Date().toISOString(),scratch,project:folders.project,executable,bridge:bridge.href,report,globalConfigurationChanged:false,providers:[],modelCalls:0},null,2));
const child=spawn(executable,[],{cwd:folders.project,env,stdio:'inherit',windowsHide:true,shell:false});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
