import * as z from 'zod/v4';
import {trustSubject} from './trust-package-crypto.mjs';
import {trustSourceRefSchema,trustAudienceSchema} from './trust-package-schema.mjs';
export const trustPermissionPreviewSchema=z.strictObject({id:z.uuid(),operationId:z.uuid(),source:trustSourceRefSchema,
  grantee:trustSubject,audience:trustAudienceSchema,expiresAt:z.number().int().nonnegative()});
export const trustSelectionSchema=z.strictObject({selections:z.array(z.strictObject({ref:trustSourceRefSchema,
  mode:z.enum(['reference','copy']),permissionId:z.uuid().optional()})).max(50),audience:trustAudienceSchema,expiresAt:z.number().int().positive()});
export const trustPermissionMutationSchema=z.strictObject({signed:z.string().max(30000)});
export const trustPermissionLookupSchema=z.strictObject({id:z.uuid()});
export const trustPermissionRevokeSchema=z.strictObject({id:z.uuid(),operationId:z.uuid()});
export const trustPermissionQuerySchema=z.strictObject({after:z.uuid().nullable().default(null),role:z.enum(['author','grantee']).default('author')});

