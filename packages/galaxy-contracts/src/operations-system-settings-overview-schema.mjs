import {z} from 'zod';
import {systemSettingsCredentialRefSchema} from './operations-system-settings-schema.mjs';

const state=z.enum(['available','unavailable','not-configured']);
const consumer=z.strictObject({
 target:z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),state:z.enum(['configured','not-configured','unavailable','unknown']),
 adoptedVersionId:z.uuid().nullable(),connectionId:z.uuid().nullable(),
 source:z.enum(['operations-database','native-keycloak','native-alertmanager','protected-runtime','consumer-ack','not-connected']),
 configured:z.boolean().nullable(),
});
const credential=z.strictObject({reference:systemSettingsCredentialRefSchema,connectionId:z.uuid(),configured:z.boolean()});
export const systemSettingsNativeOverviewSchema=z.strictObject({
 availability:z.strictObject({state}),current:z.array(consumer).max(20),credentials:z.array(credential).max(100),
 observedConfiguration:z.unknown().nullable(),
 capabilities:z.strictObject({canTest:z.boolean(),canApply:z.boolean(),canWriteCredential:z.boolean()}),
});
