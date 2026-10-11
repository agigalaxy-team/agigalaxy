import {readFile,writeFile,mkdir,cp,stat} from 'node:fs/promises';
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
export async function generateHostConfigs({packageDirectory=here,configPath,destination,nodePath=process.execPath,traeNodeCommand='node',hosts=defaultHosts}){
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
  await save('opencode/galaxy.tui.mjs','import {createNativeGalaxyPlugin} from '+JSON.stringify(pathToFileURL(join(packageDirectory,'opencode.js')).href)+';\nexport default createNativeGalaxyPlugin({configPath:'+JSON.stringify(configPath)+'});\n');
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
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await generateHostConfigs({configPath:process.argv[2],destination:process.argv[3],nodePath:process.argv[4]??process.execPath})));
