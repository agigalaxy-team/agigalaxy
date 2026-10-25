import {z} from 'zod';
import {systemSettingsOperationSchema,systemSettingsMailPurposes,systemSettingsCredentialRefSchema,parseSystemSettings} from './schema.mjs';

const iso=value=>value?new Date(value).toISOString():null;
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
export function versionView(row){return row?{id:row.id,revision:row.revision,configuration:row.configuration,createdAt:iso(row.created_at)}:null;}
export function operationView(row){
 if(!row)return null;
 return parseSystemSettings(systemSettingsOperationSchema,{operationId:row.operation_id,section:row.section,kind:row.kind,state:row.state,
  versionId:row.version_id??null,revision:row.revision,phases:row.result?.phases??[],
  ...(row.result?.credentialRef?{credentialRef:row.result.credentialRef}:{}),
  startedAt:iso(row.created_at),finishedAt:['completed','partial','failed'].includes(row.state)?iso(row.updated_at):null,
 });
}
export const emptySystemSettingsConfiguration=section=>section==='mail'
 ?{connections:[],bindings:Object.fromEntries(systemSettingsMailPurposes.map(purpose=>[purpose,null]))}:{connections:[]};
export function unavailableNativeOverview(configured){return{availability:{state:configured?'unavailable':'not-configured'},current:[],credentials:[],observedConfiguration:null,capabilities:{canTest:false,canApply:false,canWriteCredential:false}};}
