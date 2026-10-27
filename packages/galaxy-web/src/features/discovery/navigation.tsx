import {SelectionRail} from '../../shared/navigation/SelectionRail';
import React from 'react';
import {carryHelpOrigin} from "../help-search/help-origin-client.mjs";

type Destination='/app/find'|'/app/search'|'/app/match';
export function discoveryTarget(path:Destination,query:string,from=location.pathname+location.search+location.hash){
 const params=new URLSearchParams();
 if(query.trim())params.set('q',query.trim().slice(0,200));
 return carryHelpOrigin(path+(params.size?'?'+params.toString():''),from);
}
export function DiscoveryTabs({path,query,navigate}:{path:Destination;query:string;navigate:(path:string)=>void}){
 return <SelectionRail active={path} className="discovery-tabs" aria-label="查找范围">{([['/app/find','全部内容'],['/app/search','方法与工具'],['/app/match','同行与项目']] as const).map(([target,label])=><a key={target} href={discoveryTarget(target,query)} aria-current={path===target?'page':undefined} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();if(path!==target)navigate(discoveryTarget(target,query));}}}>{label}</a>)}</SelectionRail>;
}
