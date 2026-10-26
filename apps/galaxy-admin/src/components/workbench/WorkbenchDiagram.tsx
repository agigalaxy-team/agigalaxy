'use client';

import {useEffect,useId,useState} from 'react';

// AI diagrams are presentation only. Mermaid is loaded on demand; directives,
// external links, custom CSS and HTML are not accepted from model output.
import {diagramSourceAllowed} from './workbench-answer-guards';

export function WorkbenchDiagram({source}:{source:string}){
  const id=useId().replace(/[^a-zA-Z0-9]/g,''),[result,setResult]=useState<{source:string;svg:string}|null>(null),[failed,setFailed]=useState<string|null>(null);
  useEffect(()=>{
    let active=true;
    if(!diagramSourceAllowed(source))return;
    const timer=setTimeout(()=>{void(async()=>{
      try{
        const {default:mermaid}=await import('mermaid');
        mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:8000,maxEdges:100,
          flowchart:{htmlLabels:false,useMaxWidth:true},theme:'base',fontFamily:'ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif',
          themeVariables:{primaryColor:'#f8f4f6',primaryTextColor:'#34303a',primaryBorderColor:'#d3c1cc',lineColor:'#a38b98',secondaryColor:'#f3f4f6',tertiaryColor:'#ffffff'},
          secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','theme','themeCSS','fontFamily','flowchart']});
        const value=await mermaid.render('galaxy-diagram-'+id,source);
        if(active){setResult({source,svg:value.svg});setFailed(null);}
      }catch{if(active)setFailed(source);}
    })();},200);
    return()=>{active=false;clearTimeout(timer);};
  },[id,source]);
  const svg=result?.source===source?result.svg:null;
  if(!svg)return <pre tabIndex={0} className="wb-answer-diagram-source" aria-label={failed===source?'图示暂以文本显示':'流程图文本'}><code>{source}</code></pre>;
  // HTML is produced exclusively by Mermaid's strict renderer, never by the
  // model. Do not call bindFunctions: diagrams cannot execute or navigate.
  return <figure className="wb-answer-diagram" aria-label="回答中的流程或层级图"><div dangerouslySetInnerHTML={{__html:svg}}/></figure>;
}
