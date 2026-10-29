import * as z from 'zod/v4';

const subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),id=z.uuid();
export const workContinuationObjectSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.enum(['task','room','project','context']),id}),
 z.strictObject({kind:z.literal('person'),id:subject}),
 z.strictObject({kind:z.literal('post'),id,versionId:id.optional()}),
 z.strictObject({kind:z.literal('capsule'),id,versionId:id}),
]);
const origin=z.url().refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password;}catch{return false;}});
const returnPath=z.string().min(5).max(2000).refine(value=>{
 if(!value.startsWith('/app')||/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)||value.includes('\\'))return false;
 try{const url=new URL(value,'https://galaxy.invalid');return url.origin==='https://galaxy.invalid'&&(url.pathname==='/app'||url.pathname.startsWith('/app/'))
  &&url.pathname+url.search+url.hash===value&&!url.searchParams.has('agentConnect')&&!url.searchParams.has('agentBridgeOrigin');}catch{return false;}
});
export const workContinuationRequestSchema=z.strictObject({version:z.literal(1),endpoint:origin,subjectId:subject,
 object:workContinuationObjectSchema,purpose:z.string().trim().min(1).max(800),
 selectedMaterials:z.array(workContinuationObjectSchema).max(8).default([]),returnTo:returnPath});
const fragment='galaxy-work=';
const fail=()=>{throw Object.assign(new Error('work_continuation_link_invalid'),{code:'work_continuation_link_invalid'});};

/** @param {z.infer<typeof workContinuationObjectSchema>} object */
export function workContinuationPath(object){
 const value=workContinuationObjectSchema.parse(object),routes={task:'tasks',room:'rooms',project:'projects',person:'people',post:'community/posts',capsule:'capsules'};
 // Material grants live in the original work view rather than a standalone
 // browser route. They may be explicitly selected as extra references only.
 if(value.kind==='context')return null;
 return '/app/'+routes[value.kind]+'/'+value.id+('versionId' in value&&value.versionId?'/versions/'+value.versionId:'');
}
function encode(value){const bytes=new TextEncoder().encode(JSON.stringify(value));return btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function decode(value){if(!/^[A-Za-z0-9_-]{1,14000}$/.test(value))fail();
 try{const bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),char=>char.charCodeAt(0));return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail();}
}

/** @param {string} website @param {z.input<typeof workContinuationRequestSchema>} request */
export function createWorkContinuationLink(website,request){
 origin.parse(website);const value=workContinuationRequestSchema.parse(request),path=workContinuationPath(value.object);if(!path)fail();
 const url=new URL(path,website);url.hash=fragment+encode(value);return url.href;
}
/** The fragment carries references and the user's purpose, never an access grant or source body. */
export function readWorkContinuationLink(link){
 let url;try{url=new URL(link);}catch{fail();}
 if(url.protocol!=='https:'||url.username||url.password||url.search||!url.hash.startsWith('#'+fragment))fail();
 const request=workContinuationRequestSchema.safeParse(decode(url.hash.slice(fragment.length+1)));if(!request.success)fail();
 if(workContinuationPath(request.data.object)!==url.pathname)fail();
 return {website:url.origin,...request.data,sourceUrl:url.origin+url.pathname,returnUrl:new URL(request.data.returnTo,url.origin).href};
}

/** Accept the ordinary copied request; the user need not extract its machine reference. */
export function workContinuationLinkFromText(value){
 if(typeof value!=='string')return null;
 const matches=[...value.matchAll(/https:\/\/[^\s<>"']+#galaxy-work=[A-Za-z0-9_-]+/g)].map(match=>match[0]);
 if(matches.length!==1)return null;
 try{readWorkContinuationLink(matches[0]);return matches[0];}catch{return null;}
}

/** @param {string} title @param {string} purpose @param {string} link */
export function workContinuationPrompt(title,purpose,link){
 readWorkContinuationLink(link);
 const label=typeof title==='string'?title.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,' ').trim().slice(0,200):'';
 return `我想继续处理${label?'“'+label+'”':'这件事'}。这次希望：${purpose.trim()}。用银河客户端的 galaxy_work_continue 读取这个链接，沿用同一身份和当前许可；只使用这里选定的资料，暂不可读的内容不要用旧副本补回。取得相关内容后帮我继续，真实外发另按我的选择执行： ${link}`;
}
