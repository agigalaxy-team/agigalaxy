import {z} from 'zod';
import {ServiceError} from './service-error.mjs';
const uuid=z.uuid().transform(value=>value.toLowerCase());
const revision=z.number().int().min(0).max(2147483646);
const safeHref=value=>{
 if(typeof value!=='string'||/[\p{Cc}\s\\]/u.test(value))return false;
 if(value.startsWith('/')&&!value.startsWith('//'))return true;
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}
};
// eslint-disable-next-line no-control-regex -- Deliberately reject or sanitize ASCII control characters.
const text=max=>z.string().trim().max(max).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
export const systemGeneralConfigurationSchema=z.strictObject({siteTitle:text(120).min(1),description:text(600),
 footerLinks:z.array(z.strictObject({label:text(100).min(1),href:z.string().max(2048).refine(safeHref)})).max(12)});
export const systemGeneralSaveSchema=z.strictObject({operationId:uuid,expectedRevision:revision,configuration:systemGeneralConfigurationSchema});
export const systemGeneralApplySchema=z.strictObject({operationId:uuid,expectedRevision:revision,versionId:uuid});
export const systemGeneralPublishSchema=z.strictObject({operationId:uuid,expectedPublicationId:uuid,
 settingsRevision:revision,versionId:uuid,settings:systemGeneralConfigurationSchema});
export function parseSystemGeneral(schema,input){const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_system_settings_request',400);return result.data;}
