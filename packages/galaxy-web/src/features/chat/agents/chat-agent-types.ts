import type {z} from 'zod/v4';
import type {managedBindingSchema} from "../../../../../galaxy-official/src/shared/binding-management-schema.mjs";
export type AgentBinding=z.infer<typeof managedBindingSchema>;
export type AgentMode='read'|'draft'|'respond';
export type AgentGrantInput={bindingId:string;mode:AgentMode;primaryResponder:boolean;expiresAt:number};
export type AgentGrantRef=AgentGrantInput&{grantId:string};
export type AgentGrant=AgentGrantRef&{roomId:string;subjectId:string;state:string;createdAt:string;revokedAt:string|null;hostRuntimeState:'unverified'};
export type AgentOperation=({kind:'grant';input:AgentGrantRef}|{kind:'revoke';input:{grantId:string}})&{roomId:string;subjectId:string;endpoint:string;state?:string;acknowledged?:boolean;canStartNewSelection?:boolean};
export type AgentResult={grantId?:string;state?:string;reason?:string;revoked?:boolean};
export type AgentForm={editing:'grant'|'child'|null;bindingId:string;mode:AgentMode;primary:boolean;hours:number;keepExpiry:boolean;expiresAt:number|null;fixedExpiry:boolean;originalGrant:AgentGrantRef|null;childTitle:string};
export const emptyAgentForm:AgentForm={editing:null,bindingId:'',mode:'draft',primary:false,hours:24,keepExpiry:false,expiresAt:null,fixedExpiry:false,originalGrant:null,childTitle:''};
export function hasAgentGrantInput(form:AgentForm):boolean{
 return form.editing==='grant'||!!form.bindingId||!!form.originalGrant||form.expiresAt!==null||form.mode!==emptyAgentForm.mode||form.primary||form.hours!==emptyAgentForm.hours||form.keepExpiry||form.fixedExpiry;
}
/** Only an untouched new form receives a default deadline; continuing preserves the exact selection. */
export function agentGrantEditorInput(form:AgentForm,selectedAt:number):AgentForm{
 return hasAgentGrantInput(form)?{...form,editing:'grant'}:{...emptyAgentForm,editing:'grant',expiresAt:selectedAt+24*3600};
}
export type AgentAttempt={kind:'grant';grantId:string;bindingId:string;mode:AgentMode;expiresAt:number};
export type AgentSelection={input:AgentGrantInput;original:AgentGrantRef|null;draftRevision:string|null};
export type AgentPreview={kind:'inspect';grant:AgentGrant}|{kind:'unavailable'}|{kind:'changed';grant:AgentGrant|null;original?:AgentGrantRef;action?:'edit'|'revoke'}|{kind:'retry';record:AgentOperation;target?:AgentGrant|null}|{kind:'switch-editor';next:Partial<AgentForm>};
export type AgentDisplay=Partial<AgentGrant>;
export type AgentClient={
 list:(roomId:string,input?:{grantId?:string;after?:string;limit?:number})=>Promise<{items:AgentGrant[];next:string|null}>;
 pending:(roomId:string)=>Promise<AgentOperation|null>;
 reviewPending:(roomId:string)=>Promise<AgentOperation|null>;
 resumePending:(roomId:string)=>Promise<AgentResult>;
 retry:(roomId:string,options:{confirmed:true})=>Promise<AgentResult>;
 grant:(roomId:string,input:AgentGrantInput,options:{confirmed:true})=>Promise<AgentResult>;
 revoke:(roomId:string,grantId:string,options:{confirmed:true})=>Promise<AgentResult>;
};
export function grantRef(grant:AgentGrantRef):AgentGrantRef{return{grantId:grant.grantId,bindingId:grant.bindingId,mode:grant.mode,primaryResponder:!!grant.primaryResponder,expiresAt:grant.expiresAt};}
export const sameGrant=(left:AgentGrantRef|null|undefined,right:AgentGrantRef|null|undefined)=>!!left&&!!right&&JSON.stringify(grantRef(left))===JSON.stringify(grantRef(right));
export const sameAgentOperation=(left:AgentOperation|null|undefined,right:AgentOperation|null|undefined)=>!!left&&!!right&&left.kind===right.kind&&left.roomId===right.roomId&&JSON.stringify(left.input)===JSON.stringify(right.input)&&left.subjectId===right.subjectId&&left.endpoint===right.endpoint;
/** Recover only an already-selected deadline; reopening never grants fresh time. */
export function retainedAgentExpiry(form:AgentForm,pending:AgentOperation|null,owner:{subjectId?:string;endpoint:string},roomId:string):number|null{
 if(typeof form.expiresAt==='number'&&Number.isInteger(form.expiresAt))return form.expiresAt;
 const original=pending?.kind==='grant'&&pending.roomId===roomId&&pending.subjectId===owner.subjectId&&pending.endpoint===owner.endpoint&&pending.input.bindingId===form.bindingId&&pending.input.mode===form.mode&&pending.input.primaryResponder===(form.mode==='respond'&&form.primary)?pending.input.expiresAt:form.keepExpiry?form.originalGrant?.expiresAt:null;
 return typeof original==='number'&&Number.isInteger(original)?original:null;
}
type AgentObservation={mode:string;primaryResponder:boolean;expiresAt:number;state:string};
export type AgentAction={kind:'inspect'|'edit'|'revoke';roomId:string;grantId:string;endpoint:string;subjectId:string;observed?:AgentObservation};
export function readAgentAction(value:unknown):AgentAction|null{
 if(!value||typeof value!=='object'||!('kind' in value)||!['inspect','edit','revoke'].includes(String(value.kind)))return null;
 if(!('roomId' in value)||typeof value.roomId!=='string'||!('grantId' in value)||typeof value.grantId!=='string'||!('endpoint' in value)||typeof value.endpoint!=='string'||!('subjectId' in value)||typeof value.subjectId!=='string')return null;
 const kind=value.kind;if(kind!=='inspect'&&kind!=='edit'&&kind!=='revoke')return null;
 const observed='observed' in value?value.observed:undefined;
 if(observed!==undefined){
  if(!observed||typeof observed!=='object'||!('mode'in observed)||typeof observed.mode!=='string'||!('primaryResponder'in observed)||typeof observed.primaryResponder!=='boolean'||!('expiresAt'in observed)||typeof observed.expiresAt!=='number'||!('state'in observed)||typeof observed.state!=='string')return null;
  return{kind,roomId:value.roomId,grantId:value.grantId,endpoint:value.endpoint,subjectId:value.subjectId,observed:{mode:observed.mode,primaryResponder:observed.primaryResponder,expiresAt:observed.expiresAt,state:observed.state}};
 }
 return{kind,roomId:value.roomId,grantId:value.grantId,endpoint:value.endpoint,subjectId:value.subjectId};
}
