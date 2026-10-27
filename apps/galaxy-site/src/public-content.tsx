import React,{cache} from 'react';
import {ReadingCode} from '../../../packages/galaxy-web/src/features/public-reading/reading-code';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {notFound} from 'next/navigation';
import {GlobalRail,SiteHeader} from '../../../packages/galaxy-web/src/site-chrome.mjs';
import {readSiteContent,safePublicFile,type SiteBlock,type SiteMedia,type SitePage} from './lib/site-content';
import {HomeInteraction} from './home-interaction';
import {PublicContentUpdates} from './public-content-updates';
import '../site.css';
import '../home-experience.css';
import '../cms-content.css';
import '../../../packages/galaxy-web/src/features/public-reading/workspace.css';

type Tree=string|{tag:string;attrs:Record<string,string>;children:Tree[]};
type PublicData={version:number;path:string;title:string;description:string;location:string;sidebar:Tree[];body:Tree[];footer:Tree[]};
const baseline=()=>resolve(/*turbopackIgnore: true*/ process.env.GALAXY_SITE_BASELINE_ROOT??resolve(process.cwd(),'dist'));
const readData=cache(async(relative:string)=>JSON.parse(await readFile((await safePublicFile(baseline(),relative.split('/'),4_000_000)).path,'utf8')));
const siteContent=cache(readSiteContent);
async function data<T>(segments:string[]):Promise<T>{return readData(segments.join('/')) as Promise<T>;}
const property:Record<string,string>={class:'className',tabindex:'tabIndex',viewbox:'viewBox',preserveaspectratio:'preserveAspectRatio','stroke-width':'strokeWidth','stroke-linecap':'strokeLinecap','stroke-linejoin':'strokeLinejoin','stroke-dasharray':'strokeDasharray','fill-rule':'fillRule','clip-rule':'clipRule',for:'htmlFor'};
function style(value:string){return Object.fromEntries(value.split(';').filter(Boolean).map(pair=>{const at=pair.indexOf(':');if(at<1)throw Error('Invalid authored style');const name=pair.slice(0,at).trim();return[name.startsWith('--')?name:name.replace(/-([a-z])/g,(_,letter:string)=>letter.toUpperCase()),pair.slice(at+1).trim()];}));}
function tree(nodes:Tree[],slots:Record<string,React.ReactNode>={},replace?: (node:Exclude<Tree,string>)=>React.ReactNode|undefined,scope='',trail=''):React.ReactNode{return nodes.map((node,index)=>{
 if(typeof node==='string')return node;
 const substitute=replace?.(node);if(substitute!==undefined)return <React.Fragment key={index}>{substitute}</React.Fragment>;
 if(node.tag==='galaxy-slot')return <React.Fragment key={index}>{Object.hasOwn(slots,node.attrs.name)?slots[node.attrs.name]:tree(node.children,slots,replace,scope,trail+'.'+index)}</React.Fragment>;
 const props:Record<string,unknown>={key:index};
 for(const [name,value]of Object.entries(node.attrs))props[property[name]??name]=name==='style'?style(value):['hidden','disabled','checked','multiple','download'].includes(name)&&value===''?true:value;
 if(node.tag==='pre'&&scope){const {key:_key,...attributes}=props;return <ReadingCode key={index} attributes={attributes} text={treeText(node.children)} scope={scope} instanceId={'public:'+trail+'.'+index}>{tree(node.children,slots,replace,scope,trail+'.'+index)}</ReadingCode>;}
 return React.createElement(node.tag,props,...(node.children.length?[tree(node.children,slots,replace,scope,trail+'.'+index)]:[]));
});}
const withoutCurrent=(nodes:Tree[]):Tree[]=>nodes.map(node=>{if(typeof node==='string')return node;const {'aria-current':_current,...attrs}=node.attrs;return {...node,attrs,children:withoutCurrent(node.children)};});
const treeText=(nodes:Tree[]):string=>nodes.map(node=>typeof node==='string'?node:treeText(node.children)).join('');
const text=(value:unknown)=>typeof value==='string'?value:'';
type Link={label:string;href:string;description?:string};
function Links({links,home=false}:{links:Link[];home?:boolean}){return home?<div className="gh-actions">{links.map((link,index)=><a key={link.href+index} className={'gh-button'+(index===0?' gh-primary':'')} href={link.href}>{link.label}</a>)}</div>:<ul className="cms-links">{links.map((link,index)=><li key={link.href+index}><a href={link.href}>{link.label}</a>{link.description&&<p>{link.description}</p>}</li>)}</ul>;}
function Blocks({blocks,media,release}:{blocks:SiteBlock[];media:SiteMedia[];release:Record<string,unknown>}){
 return blocks.map((block,index)=>{
  const heading=text(block.heading),title=heading?<h2>{heading}</h2>:null;
  if(block.blockType==='hero')return <section key={index} className="cms-block cms-hero">{title}{!!block.text&&<p>{text(block.text)}</p>}<Links links={block.links as Link[]}/></section>;
  if(block.blockType==='prose')return <section key={index} className="cms-block cms-prose">{title}{text(block.body).replace(/\r\n/g,'\n').split(/\n\s*\n/).filter(value=>value.trim()).map((paragraph,key)=><p key={key}>{paragraph.split('\n').map((line,at)=><React.Fragment key={at}>{at>0&&<br/>}{line}</React.Fragment>)}</p>)}</section>;
  if(block.blockType==='linkList')return <nav key={index} className="cms-block cms-link-list" aria-label={heading||'相关内容'}>{title}<Links links={block.links as Link[]}/></nav>;
  if(block.blockType==='notice')return <aside key={index} className={'cms-block cms-notice cms-notice-'+text(block.tone)}><h2>{text(block.title)}</h2><p>{text(block.text)}</p></aside>;
  if(block.blockType==='image'){
   const item=media.find(item=>item.id===block.mediaId);if(!item)throw Error('Missing published image');
   return <figure key={index} className="cms-block cms-image"><img src={'/media/cms/'+encodeURIComponent(item.id)+'/'+encodeURIComponent(item.filename)} alt={item.alt} width={item.width??undefined} height={item.height??undefined} loading="lazy" decoding="async"/>{(!!block.caption||!!item.credit)&&<figcaption>{!!block.caption&&<p>{text(block.caption)}</p>}{!!item.credit&&<p className="cms-media-credit">{item.credit}</p>}</figcaption>}</figure>;
  }
  if(block.blockType==='releaseLinks'){
   const native=release.nativeClientDownload as {installBundle?:{filename:string;version:string};package?:{filename:string;version:string};downloadBase?:string}|undefined;
   const selected=native?.installBundle??native?.package;
   if(!selected||!native?.downloadBase||!/^[\w.-]+$/.test(selected.filename))throw Error('Stable client download metadata is unavailable');
   return <section key={index} className="cms-block cms-release-links">{title}<p>银河客户端 {selected.version}</p><Links links={[{label:text(block.label),href:native.downloadBase+encodeURIComponent(selected.filename)},{label:'安装说明',href:'/downloads/'},{label:'发行资料',href:'/downloads/verification/'}]}/></section>;
  }
  throw Error('Unsupported published block');
 });
}
function intro(page:SitePage){return <header className="reading-intro"><h1>{page.title}</h1><p>{page.description}</p></header>;}
export async function PublicPage({pathname}:{pathname:string}){
 const path=pathname==='/'?'/':pathname.replace(/\/$/,'')+'/',content=await siteContent();
 const page=content.snapshot?.pages.find(item=>item.path===path),settings=content.snapshot?.settings;
 const release=await data<Record<string,unknown>>(['release.json']),media=content.snapshot?.media??[];
 if(path==='/'){
  const home=await data<{version:number;title:string;description:string;header:Tree[];body:Tree[];footer:Tree[]}>(['assets','home-content.json']);
  const slots:Record<string,React.ReactNode>={};
  if(page){const hero=page.blocks.find(block=>block.blockType==='hero');slots['home-hero']=<div className="gh-hero-copy"><h1>{text(hero?.heading)||page.title}</h1><p>{text(hero?.text)||page.description}</p><Links home links={hero?.links as Link[]??[{label:'探索银河',href:'/app/'},{label:'接入我的 AI',href:'/downloads/'}]}/></div>;slots['page-extra']=<div className="cms-home-content"><Blocks blocks={page.blocks.filter(block=>block!==hero)} media={media} release={release}/></div>;}
  if(settings)slots['footer-links']=settings.footerLinks.map(link=><a key={link.href} href={link.href}>{link.label}</a>);
  return <><a className="skip" href="#main">跳到内容</a>{tree(home.header)}<main id="main" className="home-shell" tabIndex={-1}>{tree(home.body,slots)}</main>{tree(home.footer,slots)}<HomeInteraction/><PublicContentUpdates publicationId={content.publicationId}/></>;
 }
 let source:PublicData|null=null;
 try{source=await data<PublicData>(['assets','public-pages',...path.split('/').filter(Boolean),'index.json']);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!source&&!page)notFound();
 const customPage=!source;
 if(customPage)source=await data<PublicData>(['assets','public-pages','how-it-works','index.json']);
 const extra=page?<Blocks blocks={page.blocks} media={media} release={release}/>:null;
 const releasePage=['/downloads/','/downloads/verification/','/status/'].includes(path);
 const body=page?(releasePage&&source?<>{tree(source.body,{},node=>(node.attrs.class??'').split(/\s+/).includes('reading-intro')?intro(page):undefined,path)}{extra}</>:<>{intro(page)}{extra}</>):tree(source!.body,{},undefined,path);
 const location=customPage?'页面':source?.location??'页面';
 const footer=source?tree(source.footer,{},settings?node=>node.tag==='nav'&&node.attrs['aria-label']==='银河说明'?<nav aria-label="银河说明">{settings.footerLinks.map(link=><a key={link.href} href={link.href}>{link.label}</a>)}</nav>:undefined:undefined):null;
 return <div className="galaxy-workspace galaxy-site selected-shell selected-public-shell"><PublicContentUpdates publicationId={content.publicationId}/><a className="site-skip" href="#main-content">跳到内容</a><GlobalRail activeHref={location==='账户'?'/app/account':''}/><SiteHeader location={location}/><main id="main-content" tabIndex={-1} className="workspace-main site-content public-content"><div className="public-reading-page"><div className="public-page-layout">{source&&tree(customPage?withoutCurrent(source.sidebar):source.sidebar)}<div className="public-page-content">{body}</div></div>{footer}</div></main></div>;
}

export async function readPublicMetadata(pathname:string){
 const path=pathname==='/'?'/':pathname.replace(/\/$/,'')+'/',content=await siteContent(),page=content.snapshot?.pages.find(item=>item.path===path);
 if(page)return {title:page.title+' · '+content.snapshot!.settings.siteTitle,description:page.description};
 if(path==='/'){const home=await data<{title:string;description:string}>(['assets','home-content.json']);return {title:home.title,description:content.snapshot?.settings.description||home.description};}
 try{const page=await data<PublicData>(['assets','public-pages',...path.split('/').filter(Boolean),'index.json']);return {title:page.title,description:page.description};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')notFound();throw error;}
}
