import {z} from 'zod';
import {ServiceError} from './service-error.mjs';

export const smtpSenderKeys=Object.freeze(['account','notice','community','updates','team']);
export const smtpHostSchema=z.string().trim().toLowerCase().max(253).regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/).refine(x=>!x.includes('..'));
export const smtpRefSchema=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const nullable=schema=>schema.nullable();
export const smtpConfigurationSchema=z.strictObject({
 enabled:z.boolean(),host:nullable(smtpHostSchema),port:nullable(z.number().int().min(1).max(65535)),
 tls:nullable(z.enum(['implicit','starttls'])),credentialRef:nullable(smtpRefSchema),
 connectionTimeoutMs:nullable(z.number().int().min(100).max(120000)),
 greetingTimeoutMs:nullable(z.number().int().min(100).max(120000)),
 socketTimeoutMs:nullable(z.number().int().min(100).max(300000)),
 maxConnections:nullable(z.number().int().min(1).max(32)),
 rateLimit:nullable(z.number().int().min(1).max(100000)),
 rateWindowSeconds:nullable(z.number().int().min(1).max(86400)),
 dkimSelector:nullable(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/)),
}).superRefine((x,ctx)=>{
 if(x.enabled&&Object.entries(x).some(([key,value])=>key!=='dkimSelector'&&value===null))ctx.addIssue({code:'custom',message:'Enabled SMTP requires explicit settings.'});
});
export const smtpSaveSchema=z.strictObject({operationId:z.uuid(),expectedVersion:z.number().int().min(0).max(2147483646),configuration:smtpConfigurationSchema});
export const smtpConnectionTestSchema=z.strictObject({operationId:z.uuid(),expectedVersion:z.number().int().positive().max(2147483646)});
export const smtpDeliveryTestSchema=smtpConnectionTestSchema.extend({accountId:z.uuid(),senderKey:z.enum(smtpSenderKeys)});
export const smtpPageSchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n).optional(),limit:z.number().int().min(1).max(100).default(25)});
export function smtpParse(schema,input){const parsed=schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_smtp_request',400);return parsed.data;}
export const emptySmtpConfiguration=()=>({enabled:false,host:null,port:null,tls:null,credentialRef:null,connectionTimeoutMs:null,greetingTimeoutMs:null,socketTimeoutMs:null,maxConnections:null,rateLimit:null,rateWindowSeconds:null,dkimSelector:null});
