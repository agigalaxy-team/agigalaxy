import {z} from 'zod/v4';
import {taskMaterialDescriptorSchema,taskMaterialPrepareSchema,taskTextSegmentSchema} from "../../../../../galaxy-contracts/src/task-material-v1-schema.mjs";

export const draftTaskTextSchema=z.union([z.string(),z.strictObject({format:z.literal('task-text-v1'),segments:z.array(taskTextSegmentSchema).max(8)})]);
export const draftMaterialBodySchema=z.strictObject({materialId:z.uuid(),text:z.string().max(10000)});
export type TaskText=z.infer<typeof draftTaskTextSchema>;
export type TaskMaterial=z.infer<typeof taskMaterialDescriptorSchema>;
export type TaskMaterialBody=z.infer<typeof draftMaterialBodySchema>;
export type TaskMaterialInput=z.infer<typeof taskMaterialPrepareSchema>;
export type TaskMaterialState={materialId?:string;status:string;availableUntil?:number;checkedAt?:number;permanent?:boolean;reason?:string};
export type TaskMaterialStates=Record<string,TaskMaterialState>;
export type TaskMaterialOptions={useTitle:boolean;useBody:boolean;summaryMode:'append'|'replace';visibility:string;titleId:string;bodyId:string};
export type TaskTextField='title'|'summary'|'goal'|'situation'|'expectedOutcome';
export const isDraftTaskText=(value:unknown):value is TaskText=>draftTaskTextSchema.safeParse(value).success;
export function isDraftMaterials(value:unknown):value is TaskMaterial[]{return Array.isArray(value)&&value.every(item=>taskMaterialDescriptorSchema.safeParse(item).success);}
export function isDraftMaterialBodies(value:unknown):value is TaskMaterialBody[]{return Array.isArray(value)&&value.every(item=>draftMaterialBodySchema.safeParse(item).success);}
