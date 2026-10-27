import type {GalaxyQueryScope} from '../shared/runtime/query-client';
type Runtime={api:{endpoint:string;snapshot:()=>unknown}};
/** The cache owner includes the Native connection generation. A new device or
 * binding cannot inherit a previous connection's private read snapshot. */
export function nativeQueryScope(runtime:Runtime|null|undefined,subjectId?:string):GalaxyQueryScope{
 const snapshot=runtime?.api.snapshot();
 const binding=snapshot&&typeof snapshot==='object'?snapshot as Record<string,unknown>:null;
 return {endpoint:runtime?.api.endpoint??'',surface:'web',identity:subjectId&&binding&&binding.subjectId!==subjectId?'unavailable':subjectId&&binding?'native:'+subjectId+':'+(typeof binding.bindingId==='string'?binding.bindingId:'disconnected')+':'+(typeof binding.generation==='number'||typeof binding.generation==='string'?String(binding.generation):''): 'anonymous'};
}
