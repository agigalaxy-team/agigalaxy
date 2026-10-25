import {discoveryQueryV2Schema,opportunityRefV2Schema} from "../../../../galaxy-official/src/shared/discovery-schema-v2.mjs";
import type {DiscoveryPurpose} from "./contracts";
import {projectErrorText,object,isDiscoveryPurpose} from "./contracts";
import type {DiscoveryInput} from "../../help-contact-view-types";

export const purposes:[DiscoveryPurpose,string][]=[['conversation','交流想法'],['reuse','了解复用'],['collaboration','一起做事'],['recruitment','了解招募']];
export const tags=(value:string)=>[...new Set(value.split(/[,，、\n]/).map(item=>item.trim()).filter(Boolean))];
export const errorMessage=(error:unknown)=>({discovery_cursor_unavailable_restart:'这次查找已更新，请重新查找。',discovery_sources_changed_retry:'相关资料已有更新，请重新查找。',discovery_preferences_disabled:'你的交流意愿目前已关闭，可在交流设置中调整。'} as Record<string,string>)[projectErrorText(error,'code')||projectErrorText(error)]??(/[\u3400-\u9fff]/.test(projectErrorText(error))?projectErrorText(error):'暂时无法读取，请稍后重试。');
export function discoveryMemory(raw:unknown):Partial<DiscoveryInput>{
 if(!object(raw))return {};
 const result:Partial<DiscoveryInput>={};
 for(const key of ['title','functions','technologies'] as const)if(typeof raw[key]==='string')result[key]=raw[key];
 if(Array.isArray(raw.selected))result.selected=raw.selected.filter(isDiscoveryPurpose);
 if(raw.submittedQuery){const query=discoveryQueryV2Schema.safeParse(raw.submittedQuery);if(query.success)result.submittedQuery={context:query.data.context,purposes:query.data.purposes};}
 // Only the body-free locator was saved in this query memory.
 if(object(raw.openedRef)&&raw.openedRef.sourceUnavailable===true&&typeof raw.openedRef.id==='string'&&typeof raw.openedRef.subjectId==='string'&&typeof raw.openedRef.projectId==='string'){
  const ref=opportunityRefV2Schema.safeParse(raw.openedRef.opportunityRef);
  // The detail endpoint checks the original opportunity reference again.
  if(ref.success)result.openedRef={id:raw.openedRef.id,subjectId:raw.openedRef.subjectId,projectId:raw.openedRef.projectId,opportunityRef:ref.data,sourceUnavailable:true};
 }
 return result;
}
