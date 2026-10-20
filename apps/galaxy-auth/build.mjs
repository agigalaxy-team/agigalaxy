import {readFile,writeFile,mkdir,readdir,copyFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GalaxyMark,GlobalRail,SiteHeader,siteChromeStyles} from '../../packages/galaxy-web/src/site-chrome.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const shellSource=path.resolve(here,'../../packages/galaxy-web/src');
const args=process.argv.slice(2),outputAt=args.indexOf('--out');
if(outputAt<0||!args[outputAt+1])throw new Error('Pass a new output directory with --out. Existing nonempty directories are preserved.');
const output=path.resolve(args[outputAt+1]);
if(output===here||here.startsWith(output+path.sep))throw new Error('Output must not contain the source directory.');
try{if((await readdir(output)).length)throw new Error('Output directory is not empty.');}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(output,{recursive:true});
const read=name=>readFile(path.join(here,name),'utf8');
const write=async(name,value)=>{const target=path.join(output,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,value);};
async function copyTree(source,target){for(const entry of await readdir(path.join(here,source),{withFileTypes:true})){const a=path.join(source,entry.name),b=path.join(target,entry.name);if(entry.isDirectory())await copyTree(a,b);else{await mkdir(path.dirname(path.join(output,b)),{recursive:true});await copyFile(path.join(here,a),path.join(output,b));}}}
const theme='themes/galaxy/login';
await write('NOTICE',await read('NOTICE'));
await write('README.md',await read('README.md'));
await write('client-contract.json',await read('client-contract.json'));
await copyTree('licenses','licenses');
await copyTree('theme/galaxy/login',theme);
const resourceSources=Object.fromEntries(await Promise.all([
 ['js/galaxy-auth.js',path.join(here,'shared/galaxy-auth.js')],
 ['js/site-search.js',path.join(shellSource,'site-search.mjs')],
 ['js/search-entry.js',path.join(here,'shared/search-entry.mjs')],
 ...siteChromeStyles.map(name=>['css/'+name,path.join(shellSource,name)]),
 ['css/galaxy-auth.css',path.join(here,'shared/galaxy-auth.css')],
].map(async([name,source])=>[name,await readFile(source,'utf8')])));
// The favicon and waiting mark use the same source geometry as the website header.
const markMarkup=renderToStaticMarkup(h(GalaxyMark,{bare:true}));
const markSvg=markMarkup.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
if(!markSvg)throw new Error('The shared GalaxyMark must render an SVG.');
const mark=markSvg.includes('xmlns=')?markSvg:markSvg.replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" ');
// One build-time content version refreshes cached entry points and their imports.
const resourceVersion=createHash('sha256').update(JSON.stringify(resourceSources)+mark).digest('hex').slice(0,12);
for(const [name,source] of Object.entries(resourceSources)){
 let content=source;
 if(name==='css/selected-shell.css')content=content.replace(/(['"])\.\/site-foundation\.css\1/g,(_,quote)=>quote+'./site-foundation.css?v='+resourceVersion+quote);
 if(name==='js/search-entry.js')content=content.replace(/(['"])\.\/site-search\.mjs\1/g,(_,quote)=>quote+'./site-search.js?v='+resourceVersion+quote);
 await write(theme+'/resources/'+name,content);
 if(name!=='js/galaxy-auth.js')await write('site/assets/'+name,content);
}
const themeProperties=(await read('theme/galaxy/login/theme.properties'))
 .replace(/^styles=.*$/m,'styles='+[...siteChromeStyles,'galaxy-auth.css'].map(name=>'css/'+name+'?v='+resourceVersion).join(' '))
 .replace(/^scripts=.*$/m,'scripts=js/galaxy-auth.js?v='+resourceVersion);
await write(theme+'/theme.properties',themeProperties);
await write(theme+'/resources/img/galaxy-mark.svg',mark+'\n');
await write('site/assets/img/galaxy-mark.svg',mark+'\n');
const websiteOrigin='https://agigalaxy.org';
const contentMarker='@@AUTHENTICATION_CONTENT@@';
const chromeLabels={
 home:'{{galaxyHome}}',discover:'{{galaxyDiscover}}',community:'{{galaxyCommunity}}',
 messages:'{{galaxyMessages}}',work:'{{galaxyWork}}',account:'{{galaxyAccountCenter}}',
 navigationLabel:'{{galaxyNavigation}}',globalNavigationLabel:'{{galaxyGlobalNavigation}}',
 searchPlaceholder:'{{galaxySearchPlaceholder}}',searchLabel:'{{galaxySearchLabel}}',
 directory:'{{galaxyDirectory}}',notifications:'{{galaxyNotifications}}',publish:'{{galaxyPublish}}',
 accountLabel:'{{galaxyReturnCenter}}',locationLabel:'{{galaxyLocationLabel}} ',
};
const frame=renderToStaticMarkup(h('div',{className:'galaxy-workspace galaxy-site selected-shell galaxy-auth-shell'},
 h('a',{className:'site-skip',href:'#main-content'},'{{galaxySkip}}'),
 h(GlobalRail,{origin:websiteOrigin,activeHref:'/app/account',labels:chromeLabels}),
 h(SiteHeader,{location:'{{galaxyArea}}',origin:websiteOrigin,labels:chromeLabels}),
 h('main',{id:'main-content',className:'workspace-main site-content auth-main',tabIndex:-1},contentMarker),
));
const layout=frame.replace(contentMarker,await read('src/layout.html'));
const ftlTokens=text=>text.replace(/\{\{([a-zA-Z0-9]+)\}\}/g,(_,key)=>'${msg("'+key+'")}');
const languages='<#if realm.internationalizationEnabled && locale.supported?size gt 1><nav class="auth-languages" aria-label="${msg("languages")}"><#list locale.supported as language><a href="${language.url}" aria-label="${language.label}"<#if language.label == locale.current> aria-current="true"</#if>>${language.label?contains("English")?then("English","中文")}</a></#list></nav></#if>';
const templateBody=ftlTokens(layout).replaceAll('@@asset@@','${url.resourcesPath}').replace('@@languages@@',languages).replace('@@form@@',await read('src/form.ftl')).replaceAll('@@resource-version@@',resourceVersion);
await write(theme+'/template.ftl',(await read('src/head.ftl')).replaceAll('@@resource-version@@',resourceVersion)+'<body class="galaxy-auth-body ${bodyClass}" data-page-id="login-${pageId}">'+templateBody+'</body></html></#macro>\n');
const messages=Object.fromEntries((await read('theme/galaxy/login/messages/messages_zh_CN.properties')).split(/\r?\n/).filter(line=>line.includes('=')).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
const escape=value=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const htmlTokens=text=>text.replace(/\{\{([a-zA-Z0-9]+)\}\}/g,(_,key)=>{if(!Object.hasOwn(messages,key))throw new Error('Missing message: '+key);return escape(messages[key]);});
for(const [target,content] of [['site/index.html','src/landing.html']]){
 const landingBody=htmlTokens(layout.replace('@@form@@',await read(content))).replaceAll('@@asset@@','/assets').replace('@@languages@@','');
 const head='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="referrer" content="no-referrer"><title>银河在线账户 · 银河</title><meta name="description" content="登录或注册银河在线账户，继续原来的事情。"><link rel="icon" href="/assets/img/galaxy-mark.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/css/site-foundation.css"><link rel="stylesheet" href="/assets/css/selected-shell.css"><link rel="stylesheet" href="/assets/css/galaxy-auth.css"><script type="module" src="/assets/js/search-entry.js"></script></head>';
 const versionedHead=head.replace(/(\/assets\/(?:css|js|img)\/[a-zA-Z0-9.-]+)(?=")/g,'$1?v='+resourceVersion);
 await write(target,versionedHead+'<body class="auth-standalone">'+landingBody+'</body></html>\n');
}
const files=[];
async function inventory(dir=''){for(const name of (await readdir(path.join(output,dir))).sort()){const rel=path.join(dir,name),meta=await stat(path.join(output,rel));if(meta.isDirectory())await inventory(rel);else files.push({path:rel.split(path.sep).join('/'),bytes:meta.size});}}
await inventory();
await write('manifest.json',JSON.stringify({schemaVersion:1,name:'galaxy-auth',version:'0.1.0',keycloakVersion:'26.7.3',theme:'galaxy',resourceVersion,files},null,2)+'\n');
console.log(JSON.stringify({output,theme:'galaxy',keycloakVersion:'26.7.3',fileCount:files.length}));
