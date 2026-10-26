import React from "react";
import {BookOpen} from "lucide-react";
import {TaskCurrentCard,TaskMaterialNotice,taskViewTitle} from "../tasks/materials/task-material-view";
import "./home.css";
import {labels} from "./contracts";
import type {Props,ContentEntry} from "./contracts";

export function contentKey(entry:ContentEntry){return entry.kind==='tasks'?entry.item.taskId:entry.kind==='capsules'?entry.item.capsuleId:entry.item.projectId;}
export function ContentCard(props:ContentEntry&{navigate:(path:string)=>void;runtime?:Props['runtime'];saveForLater?:React.ReactNode}){
 return props.kind==='tasks'?<TaskCurrentCard runtime={props.runtime} task={props.item}>{item=><ReadableContentCard {...props} item={item}/>}</TaskCurrentCard>:<ReadableContentCard {...props}/>;
}
function ReadableContentCard(props:ContentEntry&{navigate:(path:string)=>void;saveForLater?:React.ReactNode}){
 const {navigate}=props;
 const data=props.kind==='tasks'?{title:taskViewTitle(props.item),description:props.item.request.summary,url:`/app/tasks/${props.item.taskId}`,meta:labels[props.item.state]??props.item.state}
  :props.kind==='capsules'?{title:props.item.title,description:props.item.problemPattern,url:`/app/capsules/${props.item.capsuleId}/versions/${props.item.versionId}`,meta:'Capsule · v'+props.item.sourceVersion}
  :{title:props.item.document.title,description:props.item.document.summary,url:`/app/projects/${props.item.projectId}`,meta:props.item.document.kind==='module'?'功能模块':'项目'};
  return <article className="content-card" id={'directory-'+props.kind+'-'+contentKey(props)}><div className="content-card-meta"><span>{data.meta}</span>{props.item.synthetic&&<span>合成演示</span>}</div><h3><a href={data.url} onClick={e=>{e.preventDefault();navigate(data.url);}}>{data.title}</a></h3><p>{data.description}</p>{props.kind==='tasks'&&<TaskMaterialNotice task={props.item}/>}{props.kind==='capsules'&&<span className="content-card-foot">{labels[props.item.sourceStatus]??props.item.sourceStatus}{props.item.deprecated?' · 已停用':''}{props.item.securityIssue?' · 有安全事项':''}</span>}{props.kind==='projects'&&<div className="content-tags">{props.item.document.functions.slice(0,3).map(f=><a key={f} href={'/app/projects?q='+encodeURIComponent(f)} aria-label={'查找与'+f+'有关的项目'} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate('/app/projects?q='+encodeURIComponent(f));}}}><span>{f}</span></a>)}</div>}<a className="content-read" href={data.url} onClick={e=>{e.preventDefault();navigate(data.url);}}>阅读详情 </a>{props.saveForLater}</article>;
}
export function BrowseHighlight(props:ContentEntry&{navigate:(path:string)=>void;runtime:Props['runtime']}){
 return props.kind==='tasks'?<TaskCurrentCard runtime={props.runtime} task={props.item}>{item=><ReadableBrowseHighlight {...props} item={item}/>}</TaskCurrentCard>:<ReadableBrowseHighlight {...props}/>;
}
function ReadableBrowseHighlight(props:ContentEntry&{navigate:(path:string)=>void}){
 const {navigate}=props;
 const title=props.kind==='tasks'?taskViewTitle(props.item):props.kind==='capsules'?props.item.title:props.item.document.title;
 const summary=props.kind==='tasks'?props.item.request.summary:props.kind==='capsules'?props.item.problemPattern:props.item.document.summary;
 const target=props.kind==='tasks'?'/app/tasks/'+props.item.taskId:props.kind==='capsules'?'/app/capsules/'+props.item.capsuleId+'/versions/'+props.item.versionId:'/app/projects/'+props.item.projectId;
 return <article className={'browse-highlight browse-highlight-'+props.kind}>
  {props.kind==='capsules'&&<BookOpen className="method-bookmark" size={21} aria-hidden="true"/>}
  <div>{props.kind==='tasks'&&<p className="browse-highlight-meta">{labels[props.item.state]??props.item.state}</p>}<h3><a href={target} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(target);}}}>{title}</a></h3><p className="browse-highlight-summary">{summary}</p>{props.kind==='tasks'&&<TaskMaterialNotice task={props.item}/>}
   {props.kind==='projects'&&!!props.item.document.functions.length&&<p className="browse-highlight-meta">{props.item.document.functions.slice(0,3).join(' · ')}</p>}
   {props.kind==='capsules'&&(props.item.sourceStatus!=='current'||props.item.deprecated||props.item.securityIssue)&&<p className="browse-highlight-meta">{props.item.deprecated?'已停用':props.item.securityIssue?'有安全事项':labels[props.item.sourceStatus]??props.item.sourceStatus}</p>}
   {props.item.synthetic&&<span className="browse-highlight-meta">合成演示</span>}
  </div>
 </article>;
}
