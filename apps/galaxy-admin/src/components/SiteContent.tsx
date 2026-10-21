type SiteLink={label:string;href:string;description?:string};
export type ContentBlock={blockType:string;heading?:string;text?:string;body?:string;links?:SiteLink[];mediaId?:string;caption?:string;tone?:string;title?:string;label?:string};
export type SiteMedia={id:string;url:string;alt:string;width?:number|null;height?:number|null;credit?:string};
export function SiteContent({blocks,media}:{blocks:ContentBlock[];media:SiteMedia[]}){
  const assets=new Map(media.map(item=>[item.id,item]));
  return <article className="galaxy-site-preview">{blocks.map((block,index)=>{
    if(block.blockType==='hero')return <header className="galaxy-preview-hero" key={index}><h1>{block.heading}</h1>{block.text&&<p>{block.text}</p>}{block.links?.length?<nav>{block.links.map(link=><a href={link.href} key={link.href}>{link.label}</a>)}</nav>:null}</header>;
    if(block.blockType==='prose')return <section key={index}>{block.heading&&<h2>{block.heading}</h2>}{block.body?.split(/\n\s*\n/).filter(Boolean).map((text,index)=><p key={index} style={{whiteSpace:'pre-wrap'}}>{text}</p>)}</section>;
    if(block.blockType==='linkList')return <section key={index}>{block.heading&&<h2>{block.heading}</h2>}<ul className="galaxy-preview-links">{block.links?.map(link=><li key={link.href}><a href={link.href}>{link.label}</a>{link.description&&<p>{link.description}</p>}</li>)}</ul></section>;
    if(block.blockType==='notice')return <aside className="galaxy-preview-notice" data-tone={block.tone} key={index}><h2>{block.title}</h2><p>{block.text}</p></aside>;
    if(block.blockType==='releaseLinks')return <section key={index}>{block.heading&&<h2>{block.heading}</h2>}<a href="https://agigalaxy.org/downloads/">{block.label||'下载银河'}</a></section>;
    const asset=assets.get(block.mediaId??'');
    return asset?<figure key={index}><img src={asset.url} alt={asset.alt} width={asset.width??undefined} height={asset.height??undefined}/>{(block.caption||asset.credit)&&<figcaption>{block.caption}{asset.credit&&<small>{asset.credit}</small>}</figcaption>}</figure>:null;
  })}</article>;
}
