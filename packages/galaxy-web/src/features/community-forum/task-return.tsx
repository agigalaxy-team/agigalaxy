import React, { useEffect, useState } from 'react';
import { useChoiceViewLease, type ChoiceViewLease } from "../../shared/operations/choice-retained-operations";
import type { ChatRuntime } from "../chat/chat-workspace-types";
import { normalizeForumOrigin } from "./community-forum-origin.mjs";

type TaskReturnProps={runtime:ChatRuntime|null;subjectId?:string;connected:boolean;task:{requesterId:string;taskId:string;request?:{operationId?:string}};navigate:(path:string)=>void};
export function CommunityTaskReturn(props:TaskReturnProps){
 const scope=useChoiceViewLease(props.runtime,props.subjectId);
 if(!props.runtime||!props.connected||!props.subjectId||props.task.requesterId!==props.subjectId||!scope.lease)return null;
 return <CommunityTaskReturnView key={JSON.stringify([scope.key,props.task.taskId,props.task.request?.operationId])} runtime={props.runtime} subjectId={props.subjectId} taskId={props.task.taskId} operationId={props.task.request?.operationId} navigate={props.navigate} lease={scope.lease}/>;
}
function CommunityTaskReturnView({runtime,subjectId,taskId,operationId,navigate,lease}:{runtime:ChatRuntime;subjectId:string;taskId:string;operationId?:string;navigate:(path:string)=>void;lease:ChoiceViewLease}){
 const [origin,setOrigin]=useState<{postId:string;versionId:string;returnTo:string}|null>(null);
 useEffect(()=>{
  let active=true;
  void runtime.getLocal('community-forum-task-origin:'+taskId,subjectId).then((value:unknown)=>{
   lease.assertCurrent();
   if(!active||!value||typeof value!=='object'||!('version'in value)||value.version!==1||!('ownerId'in value)||value.ownerId!==subjectId||!('endpoint'in value)||value.endpoint!==runtime.api.endpoint||!('taskId'in value)||value.taskId!==taskId||!operationId||!('operationId'in value)||value.operationId!==operationId||!('origin'in value))return;
   const raw=value.origin;if(!raw||typeof raw!=='object'||!('postId'in raw)||typeof raw.postId!=='string'||!('versionId'in raw)||typeof raw.versionId!=='string')return;
   const result=normalizeForumOrigin(raw);if(result)setOrigin({postId:raw.postId,versionId:raw.versionId,returnTo:result.returnTo});
  }).catch(()=>{if(active)setOrigin(null);});
  return()=>{active=false;};
 },[runtime,subjectId,taskId,operationId,lease]);
 return origin?<p className="browse-note"><a href={origin.returnTo} onClick={event=>{event.preventDefault();lease.assertCurrent();navigate(origin.returnTo);}}>返回原帖子版本</a></p>:null;
}
