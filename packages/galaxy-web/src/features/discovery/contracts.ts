import type {createWebRuntime} from "../../runtime.mjs";


export type Props={runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;navigate:(path:string)=>void};
export type Kind='tasks'|'capsules'|'projects';
export type TaskBrowseItem={taskId:string;state:string;request:{title:string;summary:string};synthetic?:boolean};
export type CapsuleBrowseItem={capsuleId:string;versionId:string;sourceVersion:number;title:string;problemPattern:string;sourceStatus:string;deprecated:boolean;securityIssue:boolean;synthetic?:boolean};
export type ProjectBrowseItem={projectId:string;document:{title:string;summary:string;kind:string;functions:string[]};synthetic?:boolean};
export type BrowsePage<T>={items:T[];nextAfter:string|null};
export type ContentEntry={kind:'tasks';item:TaskBrowseItem}|{kind:'capsules';item:CapsuleBrowseItem}|{kind:'projects';item:ProjectBrowseItem};
export const directories={tasks:{title:'正在找帮助',subtitle:'看看有哪些你能参与的事。',path:'/app/participate',endpoint:'/v2/tasks/query'},capsules:{title:'方法与经验',subtitle:'读一份做法，带回自己的工作。',path:'/app/capsules',endpoint:'/v2/capsules/query'},projects:{title:'项目与模块',subtitle:'了解大家正在做什么。',path:'/app/projects',endpoint:'/v2/projects/directory/query'}};
export const labels:Record<string,string>={open:'正在征集',closed:'已结束',canceled:'已取消',current:'来源当前可用','source-unavailable':'来源目前不可用','source-result-superseded':'来源已有纠正版本','source-currentness-unavailable':'来源结果的当前支持状态未知'};
