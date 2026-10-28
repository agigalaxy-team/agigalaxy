import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import * as z from 'zod/v4';
import {nativeA2aSchema} from './adapters/a2a.mjs';
import {nativeWatchHostConfigSchema} from './watch/host-config.mjs';
import {nativeWorkerPacksSchema} from './adapters/worker-pack-host.mjs';
import {nativeNotificationConfigSchema} from './notifications/config.mjs';

const pin=z.strictObject({publicKeyPem:z.string().min(1).max(4096),notBefore:z.number().int(),notAfter:z.number().int(),revoked:z.boolean()});
export const nativeConfigSchema=z.strictObject({version:z.literal(2),endpoint:z.url(),website:z.url(),dataDirectory:z.string().refine(isAbsolute),trustedKeys:z.record(z.string().min(1).max(160),pin),a2a:nativeA2aSchema.optional(),watchHost:nativeWatchHostConfigSchema.optional(),workerPacks:nativeWorkerPacksSchema.optional(),hostNotifications:nativeNotificationConfigSchema.optional()}).refine(config=>!config.workerPacks||config.workerPacks.workers.every(worker=>config.a2a?.peers.some(peer=>peer.id===worker.peerId)),'Every Worker requires an explicitly configured A2A peer');

const fail=(code,cause)=>{throw Object.assign(new Error(code,{cause}),{code});};
// Shared by stdio and the ordinary OpenCode plugin. It reads only the explicitly
// selected public configuration, never a host provider file or identity key.
export async function readNativeConfiguration(configPath){
 if(!configPath)fail('native_configuration_missing');
 if(typeof configPath!=='string'||!isAbsolute(configPath))fail('native_configuration_path_required');
 let raw;
 try{raw=await readFile(configPath,'utf8');}catch(error){fail(error.code==='ENOENT'?'native_configuration_not_found':'native_configuration_unreadable',error);}
 if(Buffer.byteLength(raw)>65536)fail('native_configuration_too_large');
 try{return nativeConfigSchema.parse(JSON.parse(raw));}catch(error){fail('native_configuration_invalid',error);}
}

export {nativeConfigurationMessage} from './configuration-message.mjs';
