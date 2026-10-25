'use client';

import {createElement,Fragment,useMemo,type ReactNode} from 'react';
import {lexer,type Token,type Tokens} from 'marked';

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
function renderText(value:string):ReactNode{
  const text=value,parts:ReactNode[]=[];let offset=0;
  // CommonMark leaves **中文句号。**后句 literal because the closing
  // punctuation touches Han text. Repair only that unparsed text-token case;
  // code, escapes, links and already-parsed emphasis keep Marked's tokens.
  for(const match of text.matchAll(/\*\*([^\n*]{1,2048})\*\*(?=\p{Script=Han})/gu)){
    if(!/\p{Script=Han}/u.test(match[1])||!/\p{P}$/u.test(match[1]))continue;
    parts.push(readableText(text.slice(offset,match.index)),<strong key={'cjk-'+match.index}>{readableText(match[1])}</strong>);offset=match.index+match[0].length;
  }
  return parts.length?<>{parts}{readableText(text.slice(offset))}</>:readableText(text);
}
function renderTokens(tokens:readonly Token[]):ReactNode{
  return tokens.map((token,index)=>{
    let node:ReactNode;
    switch(token.type){
      case 'space':case 'def':return null;
      case 'heading':{const item=token as Tokens.Heading;node=createElement('h'+Math.min(6,item.depth+2),null,renderTokens(item.tokens));break;}
      case 'paragraph':node=<p>{renderTokens((token as Tokens.Paragraph).tokens)}</p>;break;
      case 'text':{const item=token as Tokens.Text;node=item.tokens?renderTokens(item.tokens):renderText(item.text);break;}
      case 'escape':node=readableText((token as Tokens.Escape).text);break;
      case 'strong':node=<strong>{renderTokens((token as Tokens.Strong).tokens)}</strong>;break;
      case 'em':node=<em>{renderTokens((token as Tokens.Em).tokens)}</em>;break;
      case 'del':node=<del>{renderTokens((token as Tokens.Del).tokens)}</del>;break;
      case 'codespan':node=<code>{readableText((token as Tokens.Codespan).text)}</code>;break;
      case 'code':{const item=token as Tokens.Code;node=<pre tabIndex={0}><code>{item.text}</code></pre>;break;}
      case 'br':node=<br/>;break;
      case 'hr':node=<hr/>;break;
      case 'blockquote':node=<blockquote>{renderTokens((token as Tokens.Blockquote).tokens)}</blockquote>;break;
      case 'list':{const item=token as Tokens.List,items=item.items.map((row,i)=><li key={i}>{row.task&&<input type="checkbox" checked={!!row.checked} disabled readOnly aria-label={row.checked?'已完成':'未完成'}/>} {renderTokens(row.tokens)}</li>);node=item.ordered?<ol start={typeof item.start==='number'?item.start:undefined}>{items}</ol>:<ul>{items}</ul>;break;}
      case 'table':{const item=token as Tokens.Table;node=<div className="wb-answer-table" data-layout={item.header.length<=4?'fit':'scroll'} tabIndex={0} role="region" aria-label="回答中的表格"><table role="table"><thead role="rowgroup"><tr role="row">{item.header.map((cell,i)=><th scope="col" role="columnheader" key={i} style={{textAlign:cell.align??undefined}}>{renderTokens(cell.tokens)}</th>)}</tr></thead><tbody role="rowgroup">{item.rows.map((row,i)=><tr role="row" key={i}>{row.map((cell,j)=><td role="cell" key={j} style={{textAlign:cell.align??undefined}}><div className="wb-answer-cell-content">{renderTokens(cell.tokens)}</div></td>)}</tr>)}</tbody></table></div>;break;}
      case 'link':{const item=token as Tokens.Link,href=safeHref(item.href);node=href?<a href={href} title={item.title??undefined} target={/^https?:/i.test(href)?'_blank':undefined} rel="noopener noreferrer">{renderTokens(item.tokens)}</a>:renderTokens(item.tokens);break;}
      case 'image':{const item=token as Tokens.Image,href=safeHref(item.href),label=readableText(item.text)||'查看图片';node=href?<a href={href} target="_blank" rel="noopener noreferrer">{label}</a>:label;break;}
      case 'html':node=<span className="wb-answer-literal">{(token as Tokens.HTML).text}</span>;break;
      default:node=token.raw;
    }
    return <Fragment key={index}>{node}</Fragment>;
  });
}
export function WorkbenchMarkdown({content}:{content:string}){
  const tokens=useMemo(()=>{try{return lexer(content,{gfm:true,breaks:true});}catch{return null;}},[content]);
  return <div className="wb-answer">{tokens?renderTokens(tokens):<p style={{whiteSpace:'pre-wrap'}}>{content}</p>}</div>;
}
