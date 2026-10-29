import {isDeepStrictEqual} from 'node:util';
import {systemGeneralConfigurationSchema} from "../../../../../packages/galaxy-contracts/src/operations-system-general-schema.mjs";

// Next emits this server helper into separate CMS and route chunks.
// A process-global Symbol keeps their trusted, non-JSON request marker identical.
export const systemGeneralIntent=Symbol.for('galaxy.admin.verified-system-general-intent.v1');
// Only the local helper can set this non-serializable context after its fresh
// system-setting authorization. Native CMS requests still use the old hook.
export const systemGeneralPublicationBoundary=enforce=>args=>args.req.context?.[systemGeneralIntent]?args.data:enforce(args);
const configuration=value=>systemGeneralConfigurationSchema.parse({siteTitle:value?.siteTitle??'银河',description:value?.description??'',
 footerLinks:(value?.footerLinks??[]).map(({label,href})=>({label,href}))});
export function enforceSystemGeneralMetadata({data,originalDoc,req}){
 const intent=req.context?.[systemGeneralIntent],old=Number(originalDoc?.systemGeneralRevision??0);
 const before=configuration(originalDoc),after=configuration({...originalDoc,...data});
 if(intent){
  if(old!==intent.expectedRevision)throw Object.assign(Error('system_settings_version_changed'),{code:'system_settings_version_changed',status:409});
  const revision=intent.kind==='save'?old+1:old;
  return{...data,systemGeneralRevision:revision,systemGeneralOperation:{version:1,operationId:intent.operationId,
   operatorId:intent.operatorId,kind:intent.kind,selection:intent.selection,revision,startedAt:intent.startedAt}};
 }
 // Native CMS edits remain usable and participate in the same CAS. A later
 // ordinary edit cannot claim an earlier custom operation as its own receipt.
 if(!isDeepStrictEqual(before,after))return{...data,systemGeneralRevision:old+1,systemGeneralOperation:null};
 return{...data,systemGeneralRevision:old,systemGeneralOperation:originalDoc?.systemGeneralOperation??null};
}
export {configuration as generalConfigurationView};
