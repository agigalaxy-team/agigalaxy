import {z} from 'zod';
import {smtpConfigurationSchema} from '../../../galaxy-contracts/src/operations-smtp-schema.mjs';
import {systemSettingsMailConnectionSchema} from '../../../galaxy-contracts/src/operations-system-settings-schema.mjs';
import {operationsSmtpCredentialAlias} from './smtp-credentials.mjs';

export const operationsMailReceiptFiles=Object.freeze({api:'/var/log/galaxy/pilot/api/operations-mail-adopted.json',worker:'/var/log/galaxy/pilot/worker/operations-mail-adopted.json'});
export const operationsMailMetadataSchema=z.strictObject({version:z.literal(1),versionId:z.uuid(),connection:systemSettingsMailConnectionSchema});
export const operationsMailReceiptSchema=z.strictObject({version:z.literal(1),versionId:z.uuid(),component:z.enum(['api','worker']),pid:z.number().int().positive(),
 checkedAt:z.number().int().nonnegative(),configurationVersion:z.number().int().nonnegative(),configuration:smtpConfigurationSchema,
 credentialConfigured:z.boolean(),credentialFile:z.string().min(1)});
export function operationsMailConfiguration(connection){
 const {id:_id,name:_name,credentialRef,...transport}=connection;
 return smtpConfigurationSchema.parse({enabled:true,...transport,credentialRef:operationsSmtpCredentialAlias(credentialRef)});
}
