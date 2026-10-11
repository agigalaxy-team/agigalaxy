import {mkdir,stat,writeFile} from 'node:fs/promises';
import {join,resolve,isAbsolute,delimiter} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {inspectServiceConfiguration} from './prepare-service-config.mjs';
import {generateHostConfigs,hostConfigOptions} from './host-configs.mjs';

const here=fileURLToPath(new URL('./',import.meta.url));
const json=value=>JSON.stringify(value,null,2)+'\n';

/** @param {string} value */
export function websiteOrigin(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password)throw Error('setup_website_invalid');
 return url.origin;
}

/** @param {{path?:string,environmentPath?:string,platform?:NodeJS.Platform}} [options] */
export async function findOpenCodeExecutable({path,environmentPath=process.env.PATH,platform=process.platform}={}){
 const candidates=path?[path]:(environmentPath??'').split(delimiter).filter(Boolean).flatMap(directory=>platform==='win32'
  ?[join(directory,'opencode.exe'),join(directory,'node_modules/opencode-ai/bin/opencode.exe')]
  :[join(directory,'opencode')]);
 for(const candidate of candidates){
  if(!isAbsolute(candidate))continue;
  try{if((await stat(candidate)).isFile())return candidate;}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
 }
 if(path)throw Error('setup_opencode_not_found');
 return null;
}

/** @param {string} path */
function commandFor(path){
 const quoted=process.platform==='win32'?"'"+path.replaceAll("'","''")+"'":"'"+path.replaceAll("'","'\"'\"'")+"'";
 return 'node '+quoted;
}

/**
 * Prepare a new, reviewable connection directory. The review sees the exact
 * public endpoint and pins that will be written; no second fetch replaces it.
 * Existing host settings, providers, identity and data are never opened here.
 * @param {{website:string,host:string,dataDirectory:string,destination:string,
 * packageDirectory?:string,nodePath?:string,openCodePath?:string,
 * fetch?:typeof globalThis.fetch,now?:number,
 * confirm:(review:{website:string,endpoint:string,operator:string|null,host:string,dataDirectory:string,destination:string,publicFingerprints:unknown[]})=>boolean|Promise<boolean>}} options
 */
export async function prepareNativeInstallation({website,host,dataDirectory,destination,packageDirectory=here,
 nodePath=process.execPath,openCodePath,fetch:fetcher=globalThis.fetch,now=Math.floor(Date.now()/1000),confirm}){
 const selected=hostConfigOptions.find(item=>item.id===host);
 if(!selected)throw Error('setup_host_invalid');
 for(const path of[dataDirectory,destination,packageDirectory,nodePath])if(!isAbsolute(path))throw Error('setup_path_invalid');
 if(resolve(dataDirectory)===resolve(destination))throw Error('setup_path_invalid');
 const service=await inspectServiceConfiguration({website:websiteOrigin(website),fetch:fetcher,now});
 const review=Object.freeze({website:service.website,endpoint:service.endpoint,operator:service.operator,host:selected.label,
  dataDirectory:resolve(dataDirectory),destination:resolve(destination),publicFingerprints:service.publicFingerprints});
 if(await confirm(review)!==true)return{prepared:false,canceled:true,identityCreated:false,connected:false,actualSettingsModified:false};
 const executable=host==='opencode'?await findOpenCodeExecutable({path:openCodePath}):null;
 // Only an explicitly selected new directory is created. wx also protects the
 // public config and launcher if another preparation races this installation.
 await mkdir(resolve(destination,'..'),{recursive:true});
 await mkdir(destination);
 const configPath=join(destination,'galaxy-public-config.json');
 await writeFile(configPath,json({version:2,endpoint:service.endpoint,website:service.website,
  dataDirectory:review.dataDirectory,trustedKeys:service.trustedKeys}),{flag:'wx',mode:0o600});
 const generated=await generateHostConfigs({packageDirectory,configPath,destination:join(destination,'host-configs'),nodePath,hosts:[host]});
 let launcher=null;
 if(host==='opencode'&&executable){
  launcher=join(destination,'run-opencode.mjs');
  const config=join(generated.destination,'opencode/opencode.json'),tui=join(generated.destination,'opencode/tui.json');
  await writeFile(launcher,"import {spawn} from 'node:child_process';\n"+
   'const child=spawn('+JSON.stringify(executable)+",process.argv.slice(2),{stdio:'inherit',windowsHide:true,env:{...process.env,OPENCODE_CONFIG:"+JSON.stringify(config)+',OPENCODE_TUI_CONFIG:'+JSON.stringify(tui)+"}});\n"+
   "child.once('error',()=>{process.stderr.write('OpenCode could not start. Check that it is still installed at the selected location.\\n');process.exitCode=1;});\n"+
   "child.once('exit',code=>{process.exitCode=code??1;});\n",{flag:'wx'});
 }
 const result={prepared:true,host,website:service.website,endpoint:service.endpoint,configPath,
  dataDirectory:review.dataDirectory,destination:resolve(destination),hostDirectory:generated.destination,
  launcher,launchCommand:launcher?commandFor(launcher):null,openCodeInstalled:host==='opencode'?Boolean(executable):null,
  identityCreated:false,connected:false,actualSettingsModified:false,publicConfigurationSha256:service.publicConfigurationSha256};
 await writeFile(join(destination,'installation.json'),json(result),{flag:'wx'});
 return result;
}

async function runSetup(){
 const prompt=createInterface({input:stdin,output:stdout});
 try{
  stdout.write('准备在当前 AI 宿主中使用银河。\n');
  const [specifiedWebsite,...extra]=process.argv.slice(2);
  if(extra.length)throw Error('setup_arguments_invalid');
  const website=specifiedWebsite??(await prompt.question('银河官网地址：')).trim();
  stdout.write(hostConfigOptions.map((host,index)=>`${index+1}. ${host.label}`).join('\n')+'\n');
  const choice=Number((await prompt.question('使用哪个宿主（输入序号）：')).trim());
  const host=Number.isSafeInteger(choice)?hostConfigOptions[choice-1]:null;
  if(!host)throw Error('setup_host_invalid');
  const defaultData=process.env.GALAXY_DATA_DIR??join(homedir(),'.galaxy');
  const dataDirectory=(await prompt.question(`原银河资料目录（直接回车使用 ${defaultData}）：`)).trim()||defaultData;
  const defaultOutput=join(homedir(),'.galaxy-connections',host.id+'-'+randomUUID().slice(0,8));
  const destination=(await prompt.question(`本次接入文件位置（直接回车使用 ${defaultOutput}）：`)).trim()||defaultOutput;
  const result=await prepareNativeInstallation({website,host:host.id,dataDirectory,destination,confirm:async review=>{
   stdout.write(`\n官网：${review.website}\n服务：${review.endpoint}\n`+
    (review.operator?`运营方说明：${review.operator}\n`:'')+
    `宿主：${review.host}\n原资料：${review.dataDirectory}\n接入文件：${review.destination}\n`);
   return /^(?:y|yes|是)$/i.test((await prompt.question('准备这次接入？只生成文件，身份与模型保持原状（y/是）：')).trim());
  }});
  if(!result.prepared){stdout.write('已取消，没有生成接入文件。\n');return;}
  stdout.write('\n接入文件已准备：'+result.destination+'\n');
  if(result.launchCommand)stdout.write('在原工作目录运行：\n'+result.launchCommand+'\n随后输入 /galaxy，按菜单准备或连接原身份。\n');
  else if(host.id==='opencode')stdout.write('当前未找到 OpenCode 可执行程序。安装 OpenCode 后，按生成目录中的 INSTALL.md 加载配置；无需修改模型信息。\n');
  else stdout.write('在当前宿主中添加生成目录内的银河连接；具体位置见 INSTALL.md。随后可继续原工作。\n');
 }finally{prompt.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await runSetup();}catch(error){
  const message=error.code==='EEXIST'?'本次接入位置已经存在。请保留原文件，选择一个新的位置。':
   error.message==='setup_host_invalid'?'请从显示的宿主列表选择一个序号。':
   error.message==='setup_path_invalid'?'资料和接入文件需要不同的完整路径。':
   error.message==='setup_opencode_not_found'?'找不到所选 OpenCode 程序。请核对安装位置。':
   '未能准备接入。请核对官网地址、公开服务配置与本机路径；原身份、模型和工作资料仍保留。';
  process.stderr.write(message+'\n');process.exitCode=1;
 }
}
