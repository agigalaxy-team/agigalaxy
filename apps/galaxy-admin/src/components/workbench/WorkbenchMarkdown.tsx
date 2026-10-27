'use client';

import {createElement,Fragment,useMemo,type ReactNode} from 'react';
import {lexer,type Token,type Tokens} from 'marked';
import {WorkbenchDiagram} from './WorkbenchDiagram';
import {WorkbenchReplyForm} from './WorkbenchReplyForm';
import './workbench-answer.css';

const entities:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
function readableText(value:string){
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi,(original,entity:string)=>{
    if(entity[0]!=='#')return entities[entity.toLowerCase()]??original;
    const number=entity[1]?.toLowerCase()==='x'?Number.parseInt(entity.slice(2),16):Number.parseInt(entity.slice(1),10);
    return number>0&&number<=0x10ffff&&!(number>=0xd800&&number<=0xdfff)?String.fromCodePoint(number):'\ufffd';
  });
}
function safeHref(value:string){
  const href=readableText(value).trim();
  if(/[\u0000-\u0020\u007f]/.test(href)||href.startsWith('//')||href.includes('\\'))return null;
  if(href.startsWith('/')||href.startsWith('#'))return href;
  try{const url=new URL(href);return ['http:','https:','mailto:'].includes(url.protocol)?href:null;}catch{return null;}
}
const graphemes=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;
function revealText(value:string,animate:boolean):ReactNode{
 if(!animate||!value)return value;
 const units=graphemes?Array.from(graphemes.segment(value),part=>part.segment):Array.from(value),parts:ReactNode[]=[];
 for(let i=0;i<units.length;i+=8)parts.push(<span key={i} className="wb-answer-token">{units.slice(i,i+8).join('')}</span>);
 return parts;
}
function renderText(value:string,animate=false):ReactNode{
 const text=value,parts:ReactNode[]=[];let offset=0;
 // Preserve the existing narrow CommonMark repair and safe escaped text.
 for(const match of text.matchAll(/\*\*([^\n*]{1,2048})\*\*(?=\p{Script=Han})/gu)){
  if(!/\p{Script=Han}/u.test(match[1])||!/\p{P}$/u.test(match[1]))continue;
  parts.push(revealText(readableText(text.slice(offset,match.index)),animate),<strong key={'cjk-'+match.index}>{revealText(readableText(match[1]),animate)}</strong>);offset=match.index+match[0].length;
 }
 return parts.length?<>{parts}{revealText(readableText(text.slice(offset)),animate)}</>:revealText(readableText(text),animate);
}
function renderTokens(tokens:readonly Token[],onDraft?:(text:string)=>void,animate=false):ReactNode{
  return tokens.map((token,index)=>{
    let node:ReactNode;
    switch(token.type){
      case 'space':case 'def':return null;
      case 'heading':{const item=token as Tokens.Heading;node=createElement('h'+Math.min(6,item.depth+2),null,renderTokens(item.tokens,onDraft,animate));break;}
      case 'paragraph':node=<p>{renderTokens((token as Tokens.Paragraph).tokens,onDraft,animate)}</p>;break;
      case 'text':{const item=token as Tokens.Text;node=item.tokens?renderTokens(item.tokens,onDraft,animate):renderText(item.text,animate);break;}
      case 'escape':node=readableText((token as Tokens.Escape).text);break;
      case 'strong':node=<strong>{renderTokens((token as Tokens.Strong).tokens,onDraft,animate)}</strong>;break;
      case 'em':node=<em>{renderTokens((token as Tokens.Em).tokens,onDraft,animate)}</em>;break;
      case 'del':node=<del>{renderTokens((token as Tokens.Del).tokens,onDraft,animate)}</del>;break;
      case 'codespan':node=<code>{readableText((token as Tokens.Codespan).text)}</code>;break;
      case 'code':{const item=token as Tokens.Code;node=item.lang==='mermaid'?<WorkbenchDiagram source={item.text}/>:item.lang==='galaxy-form'?<WorkbenchReplyForm source={item.text} onDraft={onDraft}/>:<pre tabIndex={0}><code>{item.text}</code></pre>;break;}
      case 'br':node=<br/>;break;
      case 'hr':node=<hr/>;break;
      case 'blockquote':node=<blockquote>{renderTokens((token as Tokens.Blockquote).tokens,onDraft,animate)}</blockquote>;break;
      case 'list':{const item=token as Tokens.List,items=item.items.map((row,i)=><li key={i}>{row.task&&<input type="checkbox" checked={!!row.checked} disabled readOnly aria-label={row.checked?'已完成':'未完成'}/>} {renderTokens(row.tokens,onDraft,animate)}</li>);node=item.ordered?<ol start={typeof item.start==='number'?item.start:undefined}>{items}</ol>:<ul>{items}</ul>;break;}
      case 'table':{const item=token as Tokens.Table;node=<div className="wb-answer-table" data-layout={item.header.length<=4?'fit':'scroll'} tabIndex={0} role="region" aria-label="回答中的表格"><table role="table"><thead role="rowgroup"><tr role="row">{item.header.map((cell,i)=><th scope="col" role="columnheader" key={i} style={{textAlign:cell.align??undefined}}>{renderTokens(cell.tokens,onDraft,animate)}</th>)}</tr></thead><tbody role="rowgroup">{item.rows.map((row,i)=><tr role="row" key={i}>{row.map((cell,j)=><td role="cell" key={j} style={{textAlign:cell.align??undefined}}><div className="wb-answer-cell-content">{renderTokens(cell.tokens,onDraft,animate)}</div></td>)}</tr>)}</tbody></table></div>;break;}
      case 'link':{const item=token as Tokens.Link,href=safeHref(item.href);node=href?<a href={href} title={item.title??undefined} target={/^https?:/i.test(href)?'_blank':undefined} rel="noopener noreferrer">{renderTokens(item.tokens,onDraft,animate)}</a>:renderTokens(item.tokens,onDraft,animate);break;}
      case 'image':{const item=token as Tokens.Image,href=safeHref(item.href),label=readableText(item.text)||'查看图片';node=href?<a href={href} target="_blank" rel="noopener noreferrer">{label}</a>:label;break;}
      case 'html':node=<span className="wb-answer-literal">{(token as Tokens.HTML).text}</span>;break;
      default:node=token.raw;
    }
    return <Fragment key={index}>{node}</Fragment>;
  });
}
export function WorkbenchMarkdown({content,onDraft,animate=false}:{content:string;onDraft?:(text:string)=>void;animate?:boolean}){
  const tokens=useMemo(()=>{try{return lexer(content,{gfm:true,breaks:true});}catch{return null;}},[content]);
  return <div className="wb-answer">{tokens?renderTokens(tokens,onDraft,animate):<p style={{whiteSpace:'pre-wrap'}}>{content}</p>}</div>;
}
