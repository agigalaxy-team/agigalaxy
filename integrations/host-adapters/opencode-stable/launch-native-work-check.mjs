import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const argument=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
const candidate=resolve(argument('candidate')),report=resolve(argument('report')),scene=JSON.parse(await readFile(resolve(argument('scene')),'utf8'));
const {prepareNativeInstallation}=await import(pathToFileURL(join(candidate,'setup.mjs')).href);
const role=scene.roles.find(value=>value.role===(argument('role')??'responder'));assert.ok(role);
const executable='C:/Users/USER1/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe';
assert.equal((await stat(executable)).isFile(),true);
const scratch=await mkdtemp(join(tmpdir(),'galaxy-native-work-check-')),here=dirname(fileURLToPath(import.meta.url));
const folders={project:join(scratch,'project'),config:join(scratch,'config'),data:join(scratch,'data'),state:join(scratch,'state'),cache:join(scratch,'cache'),temp:join(scratch,'temp')};
await Promise.all(Object.values(folders).map(path=>mkdir(path,{recursive:true})));await mkdir(dirname(report),{recursive:true});
// The normal setup reads the live HTTPS public configuration. This is the
// scene's existing Native directory, never a replacement key or another owner.
const installation=await prepareNativeInstallation({website:role.origin,host:'opencode',packageDirectory:candidate,
 dataDirectory:role.dataDirectory,destination:join(scratch,'connection'),openCodePath:executable,confirm:()=>true});
assert.equal(installation.connected,false);assert.equal(installation.identityCreated,false);
const config=join(folders.config,'opencode','opencode.json'),tui=join(scratch,'tui.json');await mkdir(dirname(config),{recursive:true});
const generatedConfig=JSON.parse(await readFile(join(installation.hostDirectory,'opencode/opencode.json'),'utf8'));
await writeFile(config,JSON.stringify({...generatedConfig,autoupdate:false,share:'disabled',enabled_providers:[],plugin:[],permission:'deny'}));
const generatedTui=JSON.parse(await readFile(join(installation.hostDirectory,'opencode/tui.json'),'utf8'));
// Use the installed public factory and exact setup config. Only the browser
// launcher is suppressed: the real local approval server is unchanged and is
// visited in a fresh headless context, never the user's desktop browser.
const headlessEntry=join(scratch,'galaxy-headless-check.tui.mjs');
await writeFile(headlessEntry,'import {createNativeGalaxyPlugin} from '+JSON.stringify(pathToFileURL(join(candidate,'opencode.js')).href)+';\n'
 +'export default createNativeGalaxyPlugin({configPath:'+JSON.stringify(installation.configPath)+',openBrowser:async()=>({launched:false}),openLink:async()=>({launched:false})});\n');
await writeFile(tui,JSON.stringify({...generatedTui,plugin:[pathToFileURL(headlessEntry).href,pathToFileURL(join(here,'native-work-check-probe.mjs')).href]}));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['systemroot','windir','comspec','pathext','path'].includes(key.toLowerCase())));
Object.assign(env,{HOME:scratch,USERPROFILE:scratch,APPDATA:folders.config,LOCALAPPDATA:folders.data,TEMP:folders.temp,TMP:folders.temp,
 XDG_CONFIG_HOME:folders.config,XDG_DATA_HOME:folders.data,XDG_STATE_HOME:folders.state,XDG_CACHE_HOME:folders.cache,
 OPENCODE_TEST_HOME:scratch,OPENCODE_CONFIG:config,OPENCODE_CONFIG_DIR:dirname(config),OPENCODE_TUI_CONFIG:tui,OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',
 OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_TERMINAL_TITLE:'1',OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER:'1',TERM:'xterm-256color',
 NODE_EXTRA_CA_CERTS:scene.certificate,GALAXY_HOST_CHECK_REPORT:report,GALAXY_HOST_CHECK_PHASE:argument('phase')??'send',GALAXY_DATA_DIR:installation.dataDirectory});
await writeFile(join(dirname(report),'actual-work-isolation.json'),JSON.stringify({recordedAt:new Date().toISOString(),scratch,project:folders.project,executable,candidate,installation,report,
 subjectId:role.subjectId,sharedSceneEndpoint:scene.endpoint,syntheticService:true,globalConfigurationChanged:false,providers:[],modelCalls:0,fixtureRuntimeInjected:false,sourceRepositoryRequiredByNative:false,
 browserLauncherSuppressed:true,userBrowserUsed:false,normalPublicPluginFactory:true,generatedTuiPreservedAt:join(installation.hostDirectory,'opencode/tui.json')},null,2));
const child=spawn(executable,[],{cwd:folders.project,env,stdio:'inherit',windowsHide:true,shell:false});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
