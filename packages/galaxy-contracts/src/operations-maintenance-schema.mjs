import {z} from 'zod';
import {maintenanceModuleIds,maintenanceOpeningConditions} from "./operations/maintenance/catalog.mjs";

const uuid=z.uuid();
const iso=z.iso.datetime({offset:true});
const point=z.string().regex(/^[a-f0-9]{64}$/);
const cursor=z.string().regex(/^[1-9][0-9]{0,15}$/);
export const maintenancePageSchema=z.strictObject({after:cursor.optional(),limit:z.coerce.number().int().min(1).max(100).default(25)});
export const maintenanceBackupsQuerySchema=z.strictObject({after:point.optional(),limit:z.coerce.number().int().min(1).max(100).default(25)});
export const maintenancePlansQuerySchema=z.strictObject({after:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(25)});
export const maintenanceLogsQuerySchema=z.strictObject({
 component:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
 level:z.enum(['all','info','warn','error']).default('all'),
 period:z.enum(['15m','1h','24h']).default('1h'),before:z.union([iso,z.string().regex(/^[0-9]{16,20}$/)]).optional(),
 limit:z.coerce.number().int().min(1).max(100).default(50),
});
export const maintenanceBackupCommandSchema=z.strictObject({
 operationId:uuid,kind:z.enum(['create','verify']),pointId:point.optional(),
}).superRefine((x,c)=>{if(x.kind==='verify'&&!x.pointId)c.addIssue({code:'custom',path:['pointId'],message:'point required'});if(x.kind==='create'&&x.pointId)c.addIssue({code:'custom',path:['pointId'],message:'not applicable'});});
export const maintenanceCreatePlanSchema=z.strictObject({
 operationId:uuid,pointId:point,scope:z.enum(['whole-site','selected-modules']).default('whole-site'),
 moduleIds:z.array(z.enum(maintenanceModuleIds)).min(1).max(maintenanceModuleIds.length).optional(),
}).superRefine((x,c)=>{if(x.scope==='selected-modules'&&!x.moduleIds)c.addIssue({code:'custom',path:['moduleIds'],message:'explicit scope required'});if(x.moduleIds&&new Set(x.moduleIds).size!==x.moduleIds.length)c.addIssue({code:'custom',path:['moduleIds'],message:'duplicate module'});if(x.scope==='whole-site'&&x.moduleIds)c.addIssue({code:'custom',path:['moduleIds'],message:'scope is server generated'});});
const planCommand={operationId:uuid,expectedRevision:z.number().int().positive()};
export const maintenanceApprovePlanSchema=z.strictObject({...planCommand,
 expectedPlanDigest:z.string().regex(/^[a-f0-9]{64}$/),
 acknowledgement:z.strictObject({point:z.literal(true),scope:z.literal(true),possibleLoss:z.literal(true),openingConditions:z.literal(true)}),
});
export const maintenanceExecutePlanSchema=z.strictObject(planCommand);
export const maintenanceCancelPlanSchema=z.strictObject(planCommand);
export const maintenanceNativeCommandSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('overview')}),
 z.strictObject({kind:z.literal('logs'),query:maintenanceLogsQuerySchema}),
 z.strictObject({kind:z.literal('catalog'),query:maintenanceBackupsQuerySchema.optional()}),
 z.strictObject({kind:z.literal('point'),pointId:point}),
 z.strictObject({kind:z.literal('backup-create'),operationId:uuid,operatorId:z.string().min(1).max(500)}),
 z.strictObject({kind:z.literal('backup-verify'),operationId:uuid,operatorId:z.string().min(1).max(500),pointId:point}),
 z.strictObject({kind:z.literal('operation'),operationId:uuid}),
 z.strictObject({kind:z.literal('restore-preview'),pointId:point,moduleIds:z.array(z.enum(maintenanceModuleIds)).min(1).max(maintenanceModuleIds.length)}),
 z.strictObject({kind:z.literal('restore-execute'),operationId:uuid,operatorId:z.string().min(1).max(500),planId:uuid,revision:z.number().int().positive(),planDigest:z.string().regex(/^[a-f0-9]{64}$/),
  approvedAt:iso,pointId:point,moduleIds:z.array(z.enum(maintenanceModuleIds)).min(1).max(maintenanceModuleIds.length),
  openingConditions:z.array(z.enum(maintenanceOpeningConditions)).length(maintenanceOpeningConditions.length),
  footprintDigest:z.string().regex(/^[a-f0-9]{64}$/)}),
]);
