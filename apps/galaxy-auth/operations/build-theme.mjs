import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GlobalRail,SiteHeader} from '../../../packages/galaxy-web/src/site-chrome.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),authSource=path.resolve(here,'..');
const ftlTokens=text=>text.replace(/\{\{([a-zA-Z0-9]+)\}\}/g,(_,key)=>'${msg("'+key+'")}');
function publicOrigin(value){const url=new URL(value);if(url.origin!==value||url.protocol!=='https:'||url.username||url.password)throw Error('Use the exact HTTPS operations origin');return url.origin;}
async function copyTree(source,target){await mkdir(target,{recursive:true});for(const entry of await readdir(source,{withFileTypes:true})){const from=path.join(source,entry.name),to=path.join(target,entry.name);if(entry.isDirectory())await copyTree(from,to);else await copyFile(from,to);}}

/** Adds one child theme to an existing Galaxy auth candidate. It never edits
 * the parent theme, ordinary realm, credentials, or a live Keycloak instance. */
export async function buildOperationsTheme({authRoot,outputRoot=authRoot,adminOrigin='https://admin.agigalaxy.org'}={}){
  if(!authRoot||!outputRoot)throw Error('Provide the built auth candidate and output root');adminOrigin=publicOrigin(adminOrigin);
  const parentRoot=path.resolve(authRoot),target=path.join(path.resolve(outputRoot),'themes/galaxy-operations/login');
  const source=path.join(here,'theme/galaxy-operations/login');
  if(target===source||source.startsWith(target+path.sep))throw Error('Do not overwrite source themes');
  try{if((await readdir(target)).length)throw Error('The operations child-theme target is not empty');}catch(error){if(error.code!=='ENOENT')throw error;}
  const [parent,manifest,layout,form]=await Promise.all([
    readFile(path.join(parentRoot,'themes/galaxy/login/template.ftl'),'utf8'),
    readFile(path.join(parentRoot,'manifest.json'),'utf8').then(JSON.parse),
    readFile(path.join(authSource,'src/layout.html'),'utf8'),readFile(path.join(authSource,'src/form.ftl'),'utf8'),
  ]);
  const bodyAt=parent.indexOf('<body '),resourceVersion=manifest.resourceVersion;
  if(bodyAt<0||typeof resourceVersion!=='string'||!resourceVersion)throw Error('Use a complete built Galaxy parent theme');
  const labels={home:'{{galaxyHome}}',discover:'{{galaxyDiscover}}',community:'{{galaxyCommunity}}',messages:'{{galaxyMessages}}',work:'{{galaxyWork}}',account:'{{galaxyAccountCenter}}',navigationLabel:'{{galaxyNavigation}}',globalNavigationLabel:'{{galaxyGlobalNavigation}}',locationLabel:'{{galaxyLocationLabel}} '};
  const websiteOrigin='https://agigalaxy.org',marker='@@OPERATIONS_AUTHENTICATION_CONTENT@@';
  const actions=h('div',{className:'selected-header-actions'},h('a',{href:adminOrigin+'/admin',className:'selected-account-entry'},'{{galaxyReturnCenter}}'));
  let frame=renderToStaticMarkup(h('div',{className:'galaxy-workspace galaxy-site selected-shell galaxy-auth-shell'},
    h('a',{className:'site-skip',href:'#main-content'},'{{galaxySkip}}'),
    h(GlobalRail,{origin:websiteOrigin,activeHref:'/app/account',labels}),
    h(SiteHeader,{location:'{{galaxyArea}}',origin:websiteOrigin,actionsNode:actions,labels}),
    h('main',{id:'main-content',className:'workspace-main site-content auth-main',tabIndex:-1},marker)));
  // GlobalRail is still the shared component. Its account destination in this
  // identity domain is the operations application, not the public account page.
  frame=frame.replaceAll('href="'+websiteOrigin+'/app/account"','href="'+adminOrigin+'/admin"');
  const languages='<#if realm.internationalizationEnabled && locale.supported?size gt 1><nav class="auth-languages" aria-label="${msg("languages")}"><#list locale.supported as language><a href="${language.url}" aria-label="${language.label}"<#if language.label == locale.current> aria-current="true"</#if>>${language.label?contains("English")?then("English","中文")}</a></#list></nav></#if>';
  const body=ftlTokens(frame.replace(marker,layout)).replaceAll('@@asset@@','${url.resourcesPath}').replace('@@languages@@',languages).replace('@@form@@',form).replaceAll('@@resource-version@@',resourceVersion);
  await copyTree(source,target);
  await writeFile(path.join(target,'template.ftl'),parent.slice(0,bodyAt)+'<body class="galaxy-auth-body ${bodyClass}" data-page-id="login-${pageId}">'+body+'</body></html></#macro>\n','utf8');
  const properties=await readFile(path.join(target,'theme.properties'),'utf8');
  await writeFile(path.join(target,'theme.properties'),properties.replace(/^galaxyWebsite=.*$/m,'galaxyWebsite='+adminOrigin),'utf8');
  return {theme:'galaxy-operations',parent:'galaxy',output:target,resourceVersion};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const value=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
  const result=await buildOperationsTheme({authRoot:value('--auth-root'),outputRoot:value('--out-root')??value('--auth-root'),adminOrigin:value('--admin-origin')??'https://admin.agigalaxy.org'});
  console.log(JSON.stringify(result));
}
