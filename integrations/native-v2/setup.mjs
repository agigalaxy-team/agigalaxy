import {mkdir,stat,lstat,writeFile,readFile,cp} from 'node:fs/promises';
import {join,resolve,isAbsolute,delimiter,relative,sep} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {inspectServiceConfiguration} from './prepare-service-config.mjs';
import {generateHostConfigs,hostConfigOptions,installOpenCodeConfiguration} from './host-configs.mjs';

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

export function openCodeConfigurationDirectory(environment=process.env,home=homedir()){
 return resolve(environment.OPENCODE_CONFIG_DIR||join(environment.XDG_CONFIG_HOME||join(home,'.config'),'opencode'));
}

async function prepareInstalledLocalWork(packageDirectory,dataDirectory,subjectType,endpoint){
 const installed=await import(pathToFileURL(join(packageDirectory,'opencode.js')).href);
 if(typeof installed.prepareOpenCodeLocalWork!=='function')throw Error('setup_local_preparation_unavailable');
 return installed.prepareOpenCodeLocalWork(dataDirectory,{subjectType,endpoint});
}

async function installOpenCodeClientPackage(packageDirectory,configurationDirectory){
 const manifest=JSON.parse(await readFile(join(packageDirectory,'native-v2.json'),'utf8'));
 if(manifest.kind!=='galaxy-native-v2-local-candidate')throw Error('setup_package_invalid');
 for(const file of['galaxy.js','opencode.js'])if(!(await stat(join(packageDirectory,file))).isFile())throw Error('setup_package_invalid');
 const installed=join(configurationDirectory,'galaxy-native','client-'+randomUUID()),withinSource=relative(resolve(packageDirectory),installed);
 if(!withinSource||(!withinSource.startsWith('..')&&!isAbsolute(withinSource)))throw Error('setup_path_invalid');
 await mkdir(configurationDirectory,{recursive:true});
 if((await lstat(configurationDirectory)).isSymbolicLink())throw Error('setup_opencode_config_conflict');
 const clientRoot=join(configurationDirectory,'galaxy-native');await mkdir(clientRoot,{recursive:true});
 if((await lstat(clientRoot)).isSymbolicLink())throw Error('setup_opencode_config_conflict');
 await cp(packageDirectory,installed,{recursive:true,errorOnExist:true,force:false});
 // npm can hoist this package's dependencies into its consumer's node_modules.
 // Capture that already installed runtime graph before moving the client; no
 // download, npm process or ambient host dependency is needed after installation.
 let packageJson;try{packageJson=JSON.parse(await readFile(join(packageDirectory,'package.json'),'utf8'));}
 catch(error){if(error.code!=='ENOENT')throw error;}
 async function dependency(name,from){
  if(!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name))throw Error('setup_dependency_invalid');
  let current=resolve(from);
  for(;;){const directory=join(current,'node_modules',name);
   try{const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('setup_dependency_invalid');
    const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));if(pkg.name!==name)throw Error('setup_dependency_invalid');return{directory,pkg};
   }catch(error){if(error.code!=='ENOENT')throw error;}
   const parent=resolve(current,'..');if(parent===current)return null;current=parent;
  }
 }
 async function capture(name,from,to,optional=false,exact){
  const source=await dependency(name,from);if(!source){if(optional)return;throw Error('setup_dependency_missing');}
  if(exact&&source.pkg.version!==exact)throw Error('setup_dependency_version');
  const found=await dependency(name,to);if(found?.pkg.version===source.pkg.version&&
   resolve(found.directory).startsWith(resolve(installed)+sep))return;
  const target=join(to,'node_modules',name);await mkdir(join(target,'..'),{recursive:true});
  await cp(source.directory,target,{recursive:true,errorOnExist:true,force:false});
  for(const child of Object.keys({...source.pkg.dependencies,...source.pkg.optionalDependencies}))
   await capture(child,source.directory,target,Object.hasOwn(source.pkg.optionalDependencies??{},child));
 }
 for(const[name,version]of Object.entries(packageJson?.dependencies??{}))await capture(name,packageDirectory,installed,false,version);
 return installed;
}

/**
 * A single installation choice covers local recording and its host entries.
 * Existing identity is reused; only the chosen OpenCode directory is merged.
 * @param {{website:string,host:string,dataDirectory:string,destination:string,
 * packageDirectory?:string,nodePath?:string,openCodePath?:string,openCodeConfigDirectory?:string,
 * subjectType?:'person'|'organization',initializeLocalWork?:(directory:string,options:{subjectType:'person'|'organization',endpoint:string})=>Promise<{created:boolean,identity:string,subjectType?:string|null,existingIdentityPreserved:boolean}>,
 * fetch?:typeof globalThis.fetch,now?:number,
 * confirm:(review:{website:string,endpoint:string,operator:string|null,host:string,dataDirectory:string,destination:string,publicFingerprints:unknown[],hostConfigDirectory:string|null,normalStartupConfigured:boolean,subjectType:'person'|'organization'})=>boolean|{confirmed:true,subjectType:'person'|'organization'}|Promise<boolean|{confirmed:true,subjectType:'person'|'organization'}>}} options
 */
export async function prepareNativeInstallation({website,host,dataDirectory,destination,packageDirectory=here,
 nodePath=process.execPath,openCodePath,openCodeConfigDirectory,subjectType='person',initializeLocalWork,
 fetch:fetcher=globalThis.fetch,now=Math.floor(Date.now()/1000),confirm}){
 const selected=hostConfigOptions.find(item=>item.id===host);
 if(!selected)throw Error('setup_host_invalid');
 for(const path of[dataDirectory,destination,packageDirectory,nodePath])if(!isAbsolute(path))throw Error('setup_path_invalid');
 if(resolve(dataDirectory)===resolve(destination))throw Error('setup_path_invalid');
 if(!['person','organization'].includes(subjectType))throw Error('setup_subject_type_invalid');
 const hostConfigDirectory=host==='opencode'?openCodeConfigDirectory??openCodeConfigurationDirectory():null;
 if(hostConfigDirectory&&!isAbsolute(hostConfigDirectory))throw Error('setup_path_invalid');
 const service=await inspectServiceConfiguration({website:websiteOrigin(website),fetch:fetcher,now});
 const review=Object.freeze({website:service.website,endpoint:service.endpoint,operator:service.operator,host:selected.label,
  dataDirectory:resolve(dataDirectory),destination:resolve(destination),publicFingerprints:service.publicFingerprints,
  hostConfigDirectory:hostConfigDirectory?resolve(hostConfigDirectory):null,
  normalStartupConfigured:hostConfigDirectory?resolve(hostConfigDirectory)===openCodeConfigurationDirectory():false,subjectType});
 const decision=await confirm(review);
 if(decision!==true&&decision?.confirmed!==true)return{prepared:false,canceled:true,identityCreated:false,connected:false,actualSettingsModified:false};
 const selectedSubjectType=decision===true?subjectType:decision.subjectType;
 if(!['person','organization'].includes(selectedSubjectType))throw Error('setup_subject_type_invalid');
 const executable=host==='opencode'?await findOpenCodeExecutable({path:openCodePath}):null;
 // Only an explicitly selected new directory is created. wx also protects the
 // public config and launcher if another preparation races this installation.
 await mkdir(resolve(destination,'..'),{recursive:true});
 await mkdir(destination);
 const configPath=join(destination,'galaxy-public-config.json');
 await writeFile(configPath,json({version:2,endpoint:service.endpoint,website:service.website,
  dataDirectory:review.dataDirectory,trustedKeys:service.trustedKeys}),{flag:'wx',mode:0o600});
 const installedPackage=host==='opencode'?await installOpenCodeClientPackage(packageDirectory,review.hostConfigDirectory):packageDirectory;
 const generated=await generateHostConfigs({packageDirectory:installedPackage,configPath,destination:join(destination,'host-configs'),nodePath,hosts:[host],dataDirectory:review.dataDirectory,endpoint:service.endpoint});
 const installed=host==='opencode'?await installOpenCodeConfiguration({directory:review.hostConfigDirectory,packageDirectory:installedPackage,configPath,
  dataDirectory:review.dataDirectory,endpoint:service.endpoint,nodePath}):null;
 // The same confirmed installation is the local agreement. Capture itself
 // never creates an identity, and an existing identity/type is not replaced.
 const local=host==='opencode'?await (initializeLocalWork
  ?initializeLocalWork(review.dataDirectory,{subjectType:selectedSubjectType,endpoint:service.endpoint})
  :prepareInstalledLocalWork(installedPackage,review.dataDirectory,selectedSubjectType,service.endpoint)):null;
 let launcher=null;
 if(host==='opencode'&&executable){
  launcher=join(destination,'run-opencode.mjs');
  await writeFile(launcher,"import {spawn} from 'node:child_process';\n"+
   'const child=spawn('+JSON.stringify(executable)+",process.argv.slice(2),{stdio:'inherit',windowsHide:true,env:{...process.env,OPENCODE_CONFIG_DIR:"+JSON.stringify(installed.directory)+"}});\n"+
   "child.once('error',()=>{process.stderr.write('OpenCode could not start. Check that it is still installed at the selected location.\\n');process.exitCode=1;});\n"+
   "child.once('exit',code=>{process.exitCode=code??1;});\n",{flag:'wx'});
 }
 const result={prepared:true,host,website:service.website,endpoint:service.endpoint,configPath,packageDirectory:installedPackage,
  dataDirectory:review.dataDirectory,destination:resolve(destination),hostDirectory:generated.destination,
  launcher,launchCommand:launcher?commandFor(launcher):null,openCodeInstalled:host==='opencode'?Boolean(executable):null,
  hostConfigDirectory:installed?.directory??null,normalStartupConfigured:review.normalStartupConfigured,subjectType:local?local.subjectType??null:selectedSubjectType,identityCreated:local?.created??false,
  existingIdentityPreserved:local?.existingIdentityPreserved??false,connected:false,actualSettingsModified:Boolean(installed),publicConfigurationSha256:service.publicConfigurationSha256};
 await writeFile(join(destination,'installation.json'),json(result),{flag:'wx'});
 return result;
}

async function runSetup(){
 const prompt=createInterface({input:stdin,output:stdout});
 try{
  stdout.write('安装银河。保留当前模型、插件和工作资料。\n');
  const args=process.argv.slice(2),options={};let specifiedWebsite;
  for(let i=0;i<args.length;i++){
   const value=args[i];
   if(['--host','--data-dir','--opencode-config-dir'].includes(value)){
    if(!args[i+1]||args[i+1].startsWith('--'))throw Error('setup_arguments_invalid');options[value]=args[++i];
   }else if(value==='--organization')options[value]=true;
   else if(!value.startsWith('--')&&!specifiedWebsite)specifiedWebsite=value;
   else throw Error('setup_arguments_invalid');
  }
  const website=specifiedWebsite??(await prompt.question('银河官网地址：')).trim();
  let host=options['--host']?hostConfigOptions.find(item=>item.id===options['--host']):null;
  if(!options['--host']&&await findOpenCodeExecutable())host=hostConfigOptions.find(item=>item.id==='opencode');
  if(!host&&!options['--host']){
   stdout.write(hostConfigOptions.map((host,index)=>`${index+1}. ${host.label}`).join('\n')+'\n');
   const choice=Number((await prompt.question('使用哪个宿主（输入序号）：')).trim());host=Number.isSafeInteger(choice)?hostConfigOptions[choice-1]:null;
  }
  if(!host)throw Error('setup_host_invalid');
  const defaultData=process.env.GALAXY_DATA_DIR??join(homedir(),'.galaxy');
  const dataDirectory=options['--data-dir']??defaultData;
  const defaultOutput=join(homedir(),'.galaxy-connections',host.id+'-'+randomUUID().slice(0,8));
  const destination=defaultOutput;
  const defaultHostDirectory=host.id==='opencode'?openCodeConfigurationDirectory():null;
  const openCodeConfigDirectory=options['--opencode-config-dir']??defaultHostDirectory??undefined;
  const subjectType=options['--organization']?'organization':'person';
  const result=await prepareNativeInstallation({website,host:host.id,dataDirectory,destination,openCodeConfigDirectory,subjectType,
   confirm:async review=>{
   stdout.write(`\n官网：${review.website}\n服务：${review.endpoint}\n`+
    (review.operator?`运营方说明：${review.operator}\n`:'')+
    `宿主：${review.host}\n本地资料：${review.dataDirectory}\n`+
    (review.hostConfigDirectory?`安装到：${review.hostConfigDirectory}\n`:'')+
    (review.hostConfigDirectory&&!review.normalStartupConfigured?'这是自定义配置目录，之后通过专用启动入口使用。\n':''));
   if(host.id==='opencode')stdout.write(`沿用已有身份；没有身份时准备${review.subjectType==='organization'?'组织':'个人'}身份。普通工作会自动记录到本机，供本人回查与当前宿主已选模型整理，只保留必要事实、来源和有限片段。默认不另存全部会话。\n上传预设“履历概况”，未接入时不会关联或上传。已有身份类型保持不变。\n`);
   const answer=(await prompt.question(host.id==='opencode'?'同意并安装（y/是；组织用途输入 org；其他取消）：':'生成此宿主的接入文件（y/是）：')).trim();
   // Choosing organization is still the same installation agreement.
   if(host.id==='opencode'&&answer==='org')return{confirmed:true,subjectType:'organization'};
   return /^(?:y|yes|是)$/i.test(answer);
  }});
  if(!result.prepared){stdout.write('已取消，没有生成接入文件。\n');return;}
  stdout.write('\n接入文件已准备：'+result.destination+'\n');
  if(host.id==='opencode'&&result.normalStartupConfigured)stdout.write('照常启动 OpenCode 即可。普通工作会自动记在本机，需要回看时打开 /galaxy 的“本地工作履历”。\n');
  else if(host.id==='opencode'&&result.launchCommand)stdout.write('在原工作目录启动：\n'+result.launchCommand+'\n');
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
