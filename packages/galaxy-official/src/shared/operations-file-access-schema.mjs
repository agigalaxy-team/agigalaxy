import * as z from 'zod/v4';

const common={operationId:z.uuid(),expectedVersion:z.string().min(1).max(8192),expectedRevision:z.number().int().min(0),reason:z.string().trim().min(3).max(1600)};
export const operationsFileAccessChangeSchema=z.discriminatedUnion('action',[
 z.strictObject({...common,action:z.literal('stop'),until:z.number().int().positive().max(253402300799)}),
 z.strictObject({...common,action:z.literal('restore')})
]);
export const operationsFileAccessOperationSchema=z.uuid();
