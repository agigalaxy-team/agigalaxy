import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),authSource=path.resolve(here,'..');
function publicOrigin(value){const url=new URL(value);if(url.origin!==value||url.protocol!=='https:'||url.username||url.password)throw Error('Use the exact HTTPS operations origin');return url.origin;}
async function copyTree(source,target){await mkdir(target,{recursive:true});for(const entry of await readdir(source,{withFileTypes:true})){const from=path.join(source,entry.name),to=path.join(target,entry.name);if(entry.isDirectory())await copyTree(from,to);else await copyFile(from,to);}}

/** Management has its own presentation; native Keycloak forms and the public theme remain independent. */
export async function buildOperationsTheme({authRoot,outputRoot=authRoot,adminOrigin='https://admin.agigalaxy.org'}={}){
 if(!authRoot||!outputRoot)throw Error('Provide the built auth candidate and output root');adminOrigin=publicOrigin(adminOrigin);
 const target=path.join(path.resolve(outputRoot),'themes/galaxy-operations/login'),source=path.join(here,'theme/galaxy-operations/login');
 if(target===source||source.startsWith(target+path.sep))throw Error('Do not overwrite source themes');
 try{if((await readdir(target)).length)throw Error('The operations child-theme target is not empty');}catch(error){if(error.code!=='ENOENT')throw error;}
 const [parent,manifest,layout,form,css,script]=await Promise.all([
  readFile(path.join(path.resolve(authRoot),'themes/galaxy/login/template.ftl'),'utf8'),
  readFile(path.join(path.resolve(authRoot),'manifest.json'),'utf8').then(JSON.parse),
  readFile(path.join(here,'src/layout.ftl'),'utf8'),readFile(path.join(authSource,'src/form.ftl'),'utf8'),
  readFile(path.join(source,'resources/css/operations-login.css'),'utf8'),readFile(path.join(source,'resources/js/operations-login.js'),'utf8'),
 ]);
 const bodyAt=parent.indexOf('<body ');if(bodyAt<0||typeof manifest.resourceVersion!=='string'||!manifest.resourceVersion)throw Error('Use a complete built Galaxy parent theme');
 const resourceVersion=createHash('sha256').update(layout+form+css+script).digest('hex').slice(0,12);
 const languages='<#if realm.internationalizationEnabled && locale.supported?size gt 1><nav class="auth-languages" aria-label="${msg("languages")}"><#list locale.supported as language><a href="${language.url}" aria-label="${language.label}"<#if language.label == locale.current> aria-current="true"</#if>>${language.label?contains("English")?then("EN","中文")}</a></#list></nav></#if>';
 const body=layout.replace('@@languages@@',languages).replace('@@form@@',form).replaceAll('@@resource-version@@',resourceVersion);
 // Keep Keycloak session checks and password controls, without the public search runtime.
 const head=parent.slice(0,bodyAt).replace(/<script type="module" src="[^"\n]*search-entry\.js[^"\n]*"><\/script>\s*/g,'');
 await copyTree(source,target);
 await writeFile(path.join(target,'template.ftl'),head+'<body class="galaxy-operations-auth ${bodyClass}" data-page-id="login-${pageId}">'+body+'</body></html></#macro>\n','utf8');
 let properties=await readFile(path.join(target,'theme.properties'),'utf8');
 properties=properties.replace(/^galaxyWebsite=.*$/m,'galaxyWebsite='+adminOrigin)+'\nstyles=css/operations-login.css?v='+resourceVersion+'\nstylesCommon=\nscripts=js/galaxy-auth.js?v='+manifest.resourceVersion+' js/operations-login.js?v='+resourceVersion+'\n';
 await writeFile(path.join(target,'theme.properties'),properties,'utf8');
 return {theme:'galaxy-operations',parent:'galaxy',output:target,resourceVersion};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const value=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
 console.log(JSON.stringify(await buildOperationsTheme({authRoot:value('--auth-root'),outputRoot:value('--out-root')??value('--auth-root'),adminOrigin:value('--admin-origin')??'https://admin.agigalaxy.org'})));
}
