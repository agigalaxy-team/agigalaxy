import {readFile,writeFile,mkdir,cp,stat,rename,unlink,lstat} from 'node:fs/promises';
import {join,isAbsolute,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const here=fileURLToPath(new URL('./',import.meta.url));
const json=x=>JSON.stringify(x,null,2)+'\n';
export const hostConfigOptions=Object.freeze([
 {id:'opencode',label:'OpenCode'},
 {id:'claude-code',label:'Claude Code'},
 {id:'github-copilot',label:'GitHub Copilot（VS Code）'},
 {id:'codex',label:'Codex'},
 {id:'cursor',label:'Cursor'},
 {id:'workbuddy',label:'WorkBuddy'},
 {id:'trae-desktop',label:'TRAE / TraeWork'},
 {id:'hermes',label:'Hermes Agent'},
 {id:'deepseek-harness',label:'DeepSeek Harness'},
]);
const defaultHosts=hostConfigOptions.filter(host=>host.id!=='opencode').map(host=>host.id);
// Generate only a NEW reviewable directory. Never open/merge a user's host
// settings, Hermes archive, credentials, or marketplace.
export async function generateHostConfigs({packageDirectory=here,configPath,destination,nodePath=process.execPath,traeNodeCommand='node',hosts=defaultHosts,dataDirectory,endpoint}){
 for(const value of[packageDirectory,configPath,destination,nodePath])if(typeof value!=='string'||!isAbsolute(value))throw new Error('Absolute package, public config, new output and Node paths required');
 if(typeof traeNodeCommand!=='string'||/\s/.test(traeNodeCommand)||!traeNodeCommand)throw new Error('TRAE requires a command without spaces');
 if(!Array.isArray(hosts)||!hosts.length||new Set(hosts).size!==hosts.length||hosts.some(id=>!hostConfigOptions.some(host=>host.id===id)))throw Error('Select an available host once');
 const selected=new Set(hosts);
 const entry=join(packageDirectory,'galaxy.js');for(const path of[entry,configPath,nodePath])if(!(await stat(path)).isFile())throw new Error('Expected installed file');
 const pkg=JSON.parse(await readFile(join(packageDirectory,'native-v2.json'),'utf8'));if(pkg.kind!=='galaxy-native-v2-local-candidate')throw new Error('Native candidate manifest required');
 if(selected.has('opencode')&&!(await stat(join(packageDirectory,'opencode.js'))).isFile())throw Error('This client package has no OpenCode entry');
 const spec={type:'stdio',command:nodePath,args:[entry],env:{GALAXY_NATIVE_CONFIG:configPath}},mcp={mcpServers:{galaxy:spec}};
 await mkdir(destination);const outputs={};
 async function save(path,value){const full=join(destination,path);await mkdir(join(full,'..'),{recursive:true});const text=typeof value==='string'?value:json(value);
  await writeFile(full,text,{flag:'wx'});outputs[path]=createHash('sha256').update(text).digest('hex');}
 async function skill(path){await cp(join(packageDirectory,'skills/galaxy'),join(destination,path),{recursive:true,errorOnExist:true});}
 if(selected.has('opencode')){
  await save('opencode/opencode.json',{$schema:'https://opencode.ai/config.json',mcp:{galaxy:{type:'local',command:[nodePath,entry],environment:spec.env,enabled:true}},skills:{paths:[join(destination,'opencode/.agents/skills')]}});
  await save('opencode/galaxy.tui.mjs',openCodePluginText({packageDirectory,configPath,dataDirectory,endpoint}));
  await save('opencode/tui.json',{$schema:'https://opencode.ai/tui.json',plugin:[pathToFileURL(join(destination,'opencode/galaxy.tui.mjs')).href]});
  await skill('opencode/.agents/skills/galaxy');
 }
 if(selected.has('claude-code')){await save('claude-code/.mcp.json',mcp);await skill('claude-code/.claude/skills/galaxy');
 await save('claude-desktop-chat/claude_desktop_config.fragment.json',mcp);}
 if(selected.has('github-copilot')){await save('copilot-vscode/.vscode/mcp.json',{servers:{galaxy:spec}});await skill('copilot-vscode/.github/skills/galaxy');}
 if(selected.has('codex')){
 await save('codex/config.fragment.toml','[mcp_servers.galaxy]\ncommand = '+JSON.stringify(nodePath)+'\nargs = '+JSON.stringify([entry])+'\n\n[mcp_servers.galaxy.env]\nGALAXY_NATIVE_CONFIG = '+JSON.stringify(configPath)+'\n');
 await skill('codex/.agents/skills/galaxy');
 const codex='codex/galaxy-native-v2';await cp(join(packageDirectory,'host-templates/codex/galaxy-native-v2'),join(destination,codex),{recursive:true,errorOnExist:true});
 await writeFile(join(destination,codex,'.mcp.json'),json(mcp));await skill(codex+'/skills/galaxy');
 }
 if(selected.has('cursor')){await save('cursor/.cursor/mcp.json',mcp);await skill('cursor/.cursor/skills/galaxy');}
 if(selected.has('workbuddy')){
 await save('workbuddy/galaxy-native-v2/mcp.json',mcp);
 await save('workbuddy/galaxy-native-v2/connector-meta.json',{name:'银河',name_zh:'银河',name_en:'Galaxy',description:'Find collaboration, tasks and permitted help through your own Agent.',
  description_zh:'使用自己的模型发现协助、发布或参与任务，通过浏览器进入银河房间。',description_en:'Use your own Agent for assistance and shared tasks; open full rooms in your browser.',
  source:'galaxy-native-v2',type:'mcp',version:'0.2.0',minWorkbuddyVersion:'4.24.0',examples_zh:['打开银河的匹配、发布和参与入口','为这个问题找可参与协助的人或 Agent'],examples_en:['Open Galaxy matching, publishing and participation','Find relevant people or Agents who can help']});
 await save('workbuddy/galaxy-native-v2/icon.svg','<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#6650df" stroke-width="3"><ellipse cx="32" cy="32" rx="27" ry="13" transform="rotate(-30 32 32)"/><ellipse cx="32" cy="32" rx="13" ry="27" transform="rotate(-30 32 32)"/></g><circle cx="32" cy="32" r="6" fill="#6650df"/><circle cx="52" cy="17" r="4" fill="#ad69e0"/></svg>\n');
 await skill('workbuddy/galaxy-native-v2/skills/galaxy');
 }
 if(selected.has('trae-desktop')){await save('trae-work/mcp.local.json',{mcpServers:{galaxy:{command:traeNodeCommand,args:[entry],env:spec.env}}});await skill('trae-work/.trae/skills/galaxy');}
 if(selected.has('hermes')){
 await save('hermes/config.fragment.yaml','mcp_servers:\n  galaxy:\n    command: '+JSON.stringify(nodePath)+'\n    args: '+JSON.stringify([entry])+'\n    env:\n      GALAXY_NATIVE_CONFIG: '+JSON.stringify(configPath)+'\n');
 await skill('hermes/skills/galaxy');
 }
 if(selected.has('deepseek-harness')){
 await save('deepseek-harness/mcp-plugin.fragment.json',{id:'mcp-galaxy',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'galaxy',transport:'stdio',command:nodePath,args:[entry],env:spec.env}});
 await skill('deepseek-harness/.dsh/skills/galaxy');
 }
 const matrix=JSON.parse(await readFile(join(packageDirectory,'host-capabilities.json'),'utf8'));await save('host-capabilities.json',matrix);
 await save('INSTALL.md',await readFile(join(packageDirectory,'HOSTS.md'),'utf8'));
 const result={schemaVersion:1,packageDirectory,publicConfigPath:configPath,generatedAt:new Date().toISOString(),hosts:[...selected],hostCount:selected.size,hostRuntimeTested:false,marketplacePublished:false,
  actualSettingsModified:false,traeCommandRequiresHostPathResolution:!isAbsolute(traeNodeCommand),outputs};
 await save('generated-configs.json',result);return{destination,...result};
}

function openCodePluginText({packageDirectory,configPath,dataDirectory,endpoint}){
 return 'import {createNativeGalaxyPlugin} from '+JSON.stringify(pathToFileURL(join(packageDirectory,'opencode.js')).href)+';\n'
  +'export default createNativeGalaxyPlugin('+JSON.stringify({configPath,dataDirectory,endpoint})+');\n';
}

// Keep comments and unrelated host settings in place. Only Galaxy's MCP entry,
// skill path and its previously installed TUI plugin are replaced.
function withoutComments(text){
 let result='',quoted=false,escaped=false;
 for(let i=0;i<text.length;i++){
  const char=text[i],next=text[i+1];
  if(quoted){result+=char;if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
  if(char==='"'){quoted=true;result+=char;continue;}
  if(char==='/'&&next==='/'){result+='  ';i+=2;while(i<text.length&&text[i]!=='\n'){result+=' ';i++;}if(i<text.length)result+='\n';continue;}
  if(char==='/'&&next==='*'){result+='  ';i+=2;while(i<text.length&&!(text[i]==='*'&&text[i+1]==='/')){result+=text[i]==='\n'?'\n':' ';i++;}if(i>=text.length)throw Error('setup_opencode_config_invalid');result+='  ';i++;continue;}
  result+=char;
 }
 if(quoted)throw Error('setup_opencode_config_invalid');
 return result;
}
function configurationObject(text){
 const clean=withoutComments(text.replace(/^\uFEFF/,' '));
 let normalized='',quoted=false,escaped=false;
 for(let i=0;i<clean.length;i++){
  const char=clean[i];
  if(quoted){normalized+=char;if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
  if(char==='"')quoted=true;
  if(char===','&&/^\s*[}\]]/.test(clean.slice(i+1)))normalized+=' ';else normalized+=char;
 }
 let value;try{value=JSON.parse(normalized);}catch{throw Error('setup_opencode_config_invalid');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('setup_opencode_config_invalid');
 return value;
}
function valueEnd(text,start){
 let quoted=false,escaped=false,depth=0;
 for(let i=start;i<text.length;i++){
  const char=text[i];
  if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
  if(char==='"'){quoted=true;continue;}
  if(char==='{'||char==='['){depth++;continue;}
  if(char==='}'||char===']'){if(depth===0)return i;if(--depth===0)return i+1;continue;}
  if(depth===0&&(char===','||/\s/.test(char)))return i;
 }
 return text.length;
}
function members(text,start){
 const clean=withoutComments(text),found=[];let index=start+1;
 while(index<clean.length){
  while(/[\s,]/.test(clean[index]??''))index++;
  if(clean[index]==='}')return{found,end:index};
  const keyStart=index;if(clean[index++]!=='"')throw Error('setup_opencode_config_invalid');
  while(index<clean.length){if(clean[index]==='\\'){index+=2;continue;}if(clean[index++]==='"')break;}
  const key=JSON.parse(clean.slice(keyStart,index));
  while(/\s/.test(clean[index]??''))index++;
  if(clean[index++]!==':')throw Error('setup_opencode_config_invalid');
  while(/\s/.test(clean[index]??''))index++;
  const begin=index,end=valueEnd(clean,begin);found.push({key,begin,end});index=end;
 }
 throw Error('setup_opencode_config_invalid');
}
function setConfigurationValue(text,path,value,start=withoutComments(text).indexOf('{')){
 const object=members(text,start),member=object.found.findLast(item=>item.key===path[0]);
 if(member&&path.length>1){
  if(text[member.begin]!=='{')throw Error('setup_opencode_config_conflict');
  return setConfigurationValue(text,path.slice(1),value,member.begin);
 }
 const nested=path.slice(1).reduceRight((child,key)=>({[key]:child}),value);
 if(member)return text.slice(0,member.begin)+JSON.stringify(nested,null,2)+text.slice(member.end);
 const last=object.found.at(-1),clean=withoutComments(text),comma=last&&!clean.slice(last.end,object.end).includes(',')?',':'';
 let head=text.slice(0,object.end);
 if(comma)head=head.slice(0,last.end)+comma+head.slice(last.end);
 const beforeClose=text.slice(text.lastIndexOf('\n',object.end-1)+1,object.end),indent=/^\s*$/.test(beforeClose)?beforeClose:'';
 return head+(head.endsWith('\n')?'':'\n')+indent+'  '+JSON.stringify(path[0])+': '+JSON.stringify(nested,null,2).replaceAll('\n','\n'+indent+'  ')+'\n'+indent+text.slice(object.end);
}
async function selectedConfigFiles(directory,basename){
 const result=[];
 for(const suffix of['.json','.jsonc']){
  const path=join(directory,basename+suffix);
  try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('setup_opencode_config_conflict');result.push({path,text:await readFile(path,'utf8')});}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return result.length?result:[{path:join(directory,basename+'.json'),text:'{}\n',missing:true}];
}
async function replaceSelectedFile(path,text,previous){
 // A simultaneous host settings edit is retained rather than overwritten.
 if(previous!==undefined&&await readFile(path,'utf8')!==previous)throw Error('setup_opencode_config_changed');
 const temporary=path+'.galaxy-'+process.pid+'-'+Math.random().toString(36).slice(2)+'.tmp';
 try{await writeFile(temporary,text,{flag:'wx',mode:0o600});await rename(temporary,path);}
 finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

/** Installs only in the directory already selected in the installation review.
 * It does not resolve provider credentials or touch project configuration. */
export async function installOpenCodeConfiguration({directory,packageDirectory=here,configPath,dataDirectory,endpoint,nodePath=process.execPath}){
 for(const value of[directory,packageDirectory,configPath,dataDirectory,nodePath])if(typeof value!=='string'||!isAbsolute(value))throw Error('setup_path_invalid');
 const target=resolve(directory);await mkdir(target,{recursive:true});
 if((await lstat(target)).isSymbolicLink())throw Error('setup_opencode_config_conflict');
 const entry=join(packageDirectory,'galaxy.js'),pluginPath=join(target,'galaxy-native.tui.mjs'),pluginUrl=pathToFileURL(pluginPath).href;
 const metadataPath=join(target,'galaxy-installation.json');
 let previous=null;try{previous=JSON.parse(await readFile(metadataPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('setup_opencode_config_invalid');}
 const oldPlugin=typeof previous?.plugin==='string'?previous.plugin:null;
 const skillPath=join(packageDirectory,'skills');
 const changes=[];
 for(const file of await selectedConfigFiles(target,'opencode')){
  const config=configurationObject(file.text),paths=config.skills?.paths??[];
  if(!Array.isArray(paths)||paths.some(item=>typeof item!=='string'))throw Error('setup_opencode_config_conflict');
  let text=setConfigurationValue(file.text,['mcp','galaxy'],{type:'local',command:[nodePath,entry],environment:{GALAXY_NATIVE_CONFIG:configPath},enabled:true});
  const oldSkill=previous?.skillPath;
  text=setConfigurationValue(text,['skills','paths'],[...paths.filter(item=>item!==skillPath&&item!==oldSkill),skillPath]);
  configurationObject(text);changes.push({...file,previous:file.text,text});
 }
 for(const file of await selectedConfigFiles(target,'tui')){
  const config=configurationObject(file.text),plugins=config.plugin??[];
  if(!Array.isArray(plugins))throw Error('setup_opencode_config_conflict');
  const own=item=>(typeof item==='string'?item:Array.isArray(item)?item[0]:null);
  const text=setConfigurationValue(file.text,['plugin'],[...plugins.filter(item=>own(item)!==pluginUrl&&(!oldPlugin||own(item)!==oldPlugin)),pluginUrl]);
  configurationObject(text);changes.push({...file,previous:file.text,text});
 }
 // All files are parsed before changing the host. No settings values are logged.
 await replaceSelectedFile(pluginPath,openCodePluginText({packageDirectory,configPath,dataDirectory,endpoint}));
 for(const file of changes)await replaceSelectedFile(file.path,file.text,file.missing?undefined:file.previous);
 await replaceSelectedFile(metadataPath,json({version:1,plugin:pluginUrl,skillPath,configPath,dataDirectory,endpoint}));
 return{directory:target,plugin:pluginPath,actualSettingsModified:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await generateHostConfigs({configPath:process.argv[2],destination:process.argv[3],nodePath:process.argv[4]??process.execPath})));
