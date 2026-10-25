import {z} from 'zod';

export const serviceConnectionKinds=Object.freeze(['analysis','recommendation','search','ai-execution','file-scanning']);
export const serviceConnectionKindSchema=z.enum(serviceConnectionKinds);
const id=z.uuid(),secret=z.string().min(32).max(4096).refine(value=>!/[\p{Cc}]/u.test(value));
const ref=z.string().regex(/^system-key:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).nullable();
export const serviceConnectionOriginSchema=z.url().max(2048).refine(value=>{
 try{const x=new URL(value);return !x.username&&!x.password&&!x.search&&!x.hash&&['','/'].includes(x.pathname)
  &&(x.protocol==='https:'||x.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(x.hostname));}catch{return false;}
}).transform(value=>new URL(value).origin);
const bindings={
 analysis:z.strictObject({id,kind:z.literal('analysis'),url:serviceConnectionOriginSchema,projectId:id,clientId:id,readClientId:id}),
 recommendation:z.strictObject({id,kind:z.literal('recommendation'),url:serviceConnectionOriginSchema}),
 search:z.strictObject({id,kind:z.literal('search'),url:serviceConnectionOriginSchema,index:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)}),
 'ai-execution':z.strictObject({id,kind:z.literal('ai-execution'),url:serviceConnectionOriginSchema}),
 'file-scanning':z.strictObject({id,kind:z.literal('file-scanning'),host:z.enum(['127.0.0.1','::1','localhost']),port:z.number().int().min(1).max(65535),timeoutMs:z.number().int().min(1000).max(60000)}),
};
export const serviceConnectionBindingSchema=z.discriminatedUnion('kind',Object.values(bindings));
export const serviceConnectionSchema=z.discriminatedUnion('kind',Object.entries(bindings).map(([kind,schema])=>kind==='file-scanning'?schema:schema.extend({credentialRef:ref})));
export const serviceConnectionsConfigurationSchema=z.strictObject({connections:z.array(serviceConnectionSchema).max(5).refine(items=>new Set(items.map(item=>item.id)).size===items.length&&new Set(items.map(item=>item.kind)).size===items.length)});
export const serviceCredentialSchemas=Object.freeze({
 analysis:z.strictObject({clientSecret:secret,readClientSecret:secret}),
 recommendation:z.strictObject({apiKey:secret}),search:z.strictObject({apiKey:secret}),
 'ai-execution':z.strictObject({signingKey:secret,serviceKey:secret}),
});
export const serviceCredentialProvisionSchema=z.union(Object.entries(serviceCredentialSchemas).map(([kind,credential])=>z.strictObject({binding:bindings[kind],credential})));
export const serviceConnectionPhaseSchema=z.strictObject({target:z.enum(['api','worker']),state:z.enum(['pending','running','completed','failed','unknown']),adoptedVersionId:id.nullable()});
export const serviceConnectionConsumerMetadataSchema=z.strictObject({version:z.literal(1),versionId:id,connections:serviceConnectionsConfigurationSchema.shape.connections});
export const serviceConnectionConsumerReadbackSchema=z.strictObject({component:z.enum(['api','worker']),versionId:id,pid:z.number().int().positive(),checkedAt:z.number().int().nonnegative(),
 connections:z.array(z.strictObject({configuration:serviceConnectionSchema,credentialsConfigured:z.boolean().nullable()})).max(5)});
export const serviceConnectionTestSchema=z.strictObject({id,kind:serviceConnectionKindSchema,state:z.enum(['available','unavailable']),checkedAt:z.number().int().nonnegative(),
 checks:z.array(z.strictObject({kind:z.enum(['transport','authentication','reader-authentication','writer-authentication','index','runtime','execution-signature','scanner-signatures']),state:z.enum(['passed','failed','not-tested'])})).max(8),
 code:z.enum(['service_connection_test_failed','service_connection_credentials_unavailable','service_connection_signatures_stale','service_connection_runtime_not_ready']).nullable()});

export function serviceConnectionBinding(configuration){const {credentialRef,...binding}=serviceConnectionSchema.parse(configuration);return serviceConnectionBindingSchema.parse(binding);}
export function serviceConnectionCredentialTarget(configuration){const binding=serviceConnectionBindingSchema.safeParse(configuration),value=binding.success?binding.data:serviceConnectionBinding(configuration);if(value.kind==='file-scanning')return null;return{section:'service-connections',id:value.id,kind:value.kind,origin:value.url};}
