/* eslint-disable nextjs/no-img-element -- This independently deployed Vite client has no Next image server. Covers use explicit dimensions and lazy loading. */
import React, {useState} from 'react';
import {BookOpen, Compass, Lightbulb, MessagesSquare, Shapes} from 'lucide-react';
import './community-content-visuals.css';

const topicIcons:Record<string,typeof MessagesSquare>={questions:Lightbulb,showcase:Shapes,methods:BookOpen,discussion:MessagesSquare};
export type ContentImage = {src:string;alt:string};

export function safeContentImageSource(value:string):string|null{
 if(value.startsWith('/images/')&&!value.includes('..')&&!value.startsWith('//'))return value;
 try{
  const url=new URL(value),ownOrigin=typeof location==='undefined'?'https://galaxy.invalid':location.origin;
  if(url.username||url.password||!['https:','http:'].includes(url.protocol))return null;
  if(url.protocol==='http:'&&url.origin!==ownOrigin)return null;
  if(url.origin!==ownOrigin&&(/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[::1\])/i.test(url.hostname)||/^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)))return null;
  if(!/\.(avif|gif|jpe?g|png|webp)$/i.test(url.pathname))return null;
  return url.href;
 }catch{return null;}
}

/** Only a picture actually linked by the author can become a post cover. No topic placeholders. */
export function contentCoverFromLinks(links:readonly string[],title:string):ContentImage|undefined{
 for(const value of links){const src=safeContentImageSource(value);if(src)return{src,alt:'文中配图：'+title};}
 return undefined;
}

export function ContentCover({image,compact=false,href,navigate}:{image?:ContentImage;compact?:boolean;href?:string;navigate?:(path:string)=>void}){
 const [failed,setFailed]=useState<string|null>(null),src=image?safeContentImageSource(image.src):null;
 if(!src||failed===src)return null;
 const picture=<img className={'community-content-cover'+(compact?' community-content-cover-compact':'')} src={src} alt={image!.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" width={compact?80:480} height={compact?80:270} onError={()=>setFailed(src)}/>;
 if(!href)return picture;
 const internal=href.startsWith('/app/');
 return <a className="community-cover-link" href={href} target={internal?undefined:'_blank'} rel={internal?undefined:'noopener noreferrer'} referrerPolicy="no-referrer" onClick={event=>{if(internal&&navigate&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(href);}}}>{picture}</a>;
}
export function TopicMark({topic='discussion',size='small'}:{topic?:string;size?:'small'|'large'}){
 const Icon=topicIcons[topic]??Compass;
 return <span className={'content-topic-mark content-topic-'+topic+' content-topic-'+size} aria-hidden="true"><Icon size={size==='large'?28:18}/></span>;
}

type PreviewProps={kind:'post'|'project'|'method';title:string;excerpt?:string;image?:{src:string;alt:string};variant?:'hero'|'tile'|'compact'};
export function ContentPreview({kind,title,excerpt,image,variant='tile'}:PreviewProps){
 const safeImage=image&&image.src.startsWith('/images/')&&!image.src.startsWith('//')&&!image.src.includes('..')?image:null;
 const firstPhrase=title.split(/[，。！？：:—｜|]/)[0];
 return <div className={'content-preview content-preview-'+kind+' content-preview-'+variant}>
  {safeImage?<img src={safeImage.src} alt={safeImage.alt} loading={variant==='hero'?'eager':'lazy'}/>:<div className="content-preview-type" aria-hidden="true"><span>{kind==='method'?'方法笔记':kind==='project'?'作品 · 项目':'正在讨论'}</span><strong>{firstPhrase.length>24?firstPhrase.slice(0,24)+'…':firstPhrase}</strong>{excerpt&&<p>{excerpt.slice(0,82)}</p>}<span className="content-preview-rule"/></div>}
 </div>;
}

export function EmptyContent({kind,title,description,action}:{kind:'post'|'project'|'method'|'people';title:string;description:string;action?:React.ReactNode}){
 return <div className={'content-empty content-empty-'+kind}><div className="content-empty-drawing" aria-hidden="true"><span/><span/><span/><TopicMark topic={kind==='method'?'methods':kind==='project'?'showcase':kind==='people'?'people':'discussion'} size="large"/></div><div><h3>{title}</h3><p>{description}</p>{action&&<div className="content-empty-action">{action}</div>}</div></div>;
}

export function ContentLinkPreview({url}:{url:string}){
 let parsed:URL;try{parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)return null;}catch{return null;}
 return <a className="content-link-preview" href={parsed.href} target="_blank" rel="noreferrer noopener"><span className="content-link-domain">{parsed.hostname.replace(/^www\./,'')}</span><span>{decodeURIComponent(parsed.pathname).replace(/\/$/,'')||'打开相关内容'}</span></a>;
}
