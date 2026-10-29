import type {z} from 'zod/v4';
import type {assistanceRequestSchema} from "../../../../galaxy-contracts/src/assistance-schema.mjs";
import type {WorkTask} from './work-task-types';

type LegacyTaskPage=Pick<WorkTask,'taskId'|'caseId'|'requesterId'|'version'|'state'>&{
 schemaVersion:1;view?:undefined;
 request:z.infer<typeof assistanceRequestSchema>&{summary?:never;workContext?:never;expectedOutcome?:never};
 participations?:{subjectId:string;state:string}[];
};
export type TaskPageTask=(WorkTask&{schemaVersion:2;view:'requester'|'participant-or-reader'|'public'})|LegacyTaskPage;

type TaskPageInput<T>={taskId:string|null;scope:string;read:(()=>Promise<T>)|null;isCurrent:()=>boolean};
export function createTaskPageView<T>({taskId,scope,read,isCurrent}:TaskPageInput<T>){
 let active=false,sequence=0;
 let snapshot:{scope:string;task:T|null;loading:boolean}={scope,task:null,loading:!!taskId&&!!read};
 const listeners=new Set<()=>void>();
 const update=(patch:Partial<typeof snapshot>)=>{snapshot={...snapshot,...patch};for(const listener of listeners)listener();};
 async function refresh(id:string,quiet=false){
  if(!active||!read||id!==taskId||!isCurrent())return false;
  const request=++sequence,current=()=>active&&request===sequence&&isCurrent();
  if(!quiet)update({loading:true});
  try{const task=await read();if(!current())return false;update({task});return true;}
  catch(reason){if(!current())return false;update({task:null});throw reason;}
  finally{if(current())update({loading:false});}
 }
 return{
  read:()=>snapshot,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  open(){active=true;},
  close(){active=false;sequence++;},
  refresh,
 };
}
