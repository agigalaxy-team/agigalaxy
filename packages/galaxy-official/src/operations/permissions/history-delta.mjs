import {isDeepStrictEqual} from "node:util";
import {z} from "zod";
import {operationsPermissionCodes} from "../../operations-permission-catalog.mjs";
import {automationResourceScopeSchema} from '../../shared/operations-automation-scope.mjs';

export const codeList=z.array(z.enum(operationsPermissionCodes)).max(operationsPermissionCodes.length).refine(items=>new Set(items).size===items.length);
export const enabledDelta=z.object({before:z.boolean().nullable(),after:z.boolean()});
export const permissionDelta=z.object({added:codeList,removed:codeList});
export const scopeIds=z.array(z.uuid()).max(100).refine(items=>new Set(items).size===items.length);
// Older events recorded exact ID arrays. Preserve that evidence as a selected
// scope, and label an old empty array unresolved rather than rewriting it as all.
const scope=z.preprocess(value=>Array.isArray(value)?(value.length?{kind:'selected',resourceIds:value}:{kind:'unresolved'}):value,automationResourceScopeSchema);
export const deltaSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('role'),permissions:permissionDelta,enabled:enabledDelta}),
 z.object({kind:z.literal('assignment'),operatorId:z.string().min(1).max(1024),roleId:z.uuid(),enabled:enabledDelta}),
 z.object({kind:z.literal('automation'),permissions:permissionDelta,enabled:enabledDelta,scope:z.object({before:scope.nullable(),after:scope}),
  mode:z.object({before:z.enum(['assisted','automatic']).nullable(),after:z.enum(['assisted','automatic'])}),
  executorKind:z.object({before:z.enum(['program','ai']).nullable(),after:z.enum(['program','ai'])}),
  aiAccountId:z.object({before:z.uuid().nullable(),after:z.uuid().nullable()}).optional()}),
]);
export const safeDelta=row=>{
 const result=deltaSchema.safeParse(row.delta);if(!result.success||result.data.kind+'-save'!==row.kind)return null;
 const delta=result.data;
 // Assignment targets are immutable. Do not turn arbitrary stored JSON text
 // into a personnel identity or associate a different role with this event.
 if(delta.kind==='assignment'&&(delta.operatorId!==row.assignment_operator_id||delta.roleId!==row.assignment_role_id))return null;
 return delta;
};
export const changedFieldNames=new Set(['name','description','enabled','permissions','operatorId','roleId','executorKind','mode','resourceIds','resourceScope','aiAccountId','subjectScope']);
const compare=(a,b)=>a<b?-1:a>b?1:0;
export const codesChanged=(before=[],after=[])=>({added:after.filter(code=>!before.includes(code)).sort(compare),removed:before.filter(code=>!after.includes(code)).sort(compare)});
export const sameSet=(a,b)=>isDeepStrictEqual([...a].sort(compare),[...b].sort(compare));
