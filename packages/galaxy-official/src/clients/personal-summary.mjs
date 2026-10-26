import * as z from 'zod/v4';
import {inboxIdSchema,inboxOptionsSchema,inboxQuerySchema} from "../shared/notification-inbox-schema.mjs";
// Uses the existing current-binding API transport. It never chooses a credential
// destination or creates a second identity/login system.
export function createPersonalSummaryClient({call}){
 if(typeof call!=='function')throw new Error('Current authenticated API transport required');
 const invoke=(method,input={},options)=>call('/v2/personal-summaries/'+method,input,options);
 return Object.freeze({preferences:(input={},o)=>invoke('preferences/read',input,o),savePreference:(x,o)=>invoke('preferences/save',x,o),
  put:(x,o)=>invoke('put',x,o),get:(x,o)=>invoke('get',x,o),receipt:(x,o)=>invoke('receipt',x,o),list:(x={},o)=>invoke('list',x,o),delete:(x,o)=>invoke('delete',x,o),
  sources:(x,o)=>invoke('sources',x,o)});
}
export function createNotificationInboxClient({call}){
 if(typeof call!=='function')throw new Error('Current authenticated API transport required');
 const invoke=(method,input={},options)=>call('/v2/notifications/'+method,input,options);
 const queryResult=z.strictObject({items:z.array(z.looseObject({id:inboxIdSchema,category:z.string(),at:z.string(),read:z.boolean(),quiet:z.boolean(),interruptiveEligible:z.boolean(),presented:z.boolean(),eventKind:z.string(),title:z.string(),object:z.looseObject({type:z.string(),id:z.string()})})),nextAfter:inboxIdSchema.nullable(),lastCheckedAt:z.string(),externalDelivery:z.literal('disabled'),deliveryConfirmed:z.literal(false)});
 const optionsResult=z.strictObject({revision:z.number().int().nonnegative(),settings:inboxOptionsSchema,externalDelivery:z.literal('disabled')});
 return Object.freeze({query:(x={},o)=>{const input=inboxQuerySchema.parse(x);return invoke('query',input,o).then(value=>queryResult.parse(value));},options:(x={},o)=>invoke('options/read',x,o).then(value=>optionsResult.parse(value)),saveOptions:(x,o)=>invoke('options/save',x,o),
  claim:(x,o)=>invoke('presentation/claim',x,o),presented:(x,o)=>invoke('presentation/ack',x,o),markRead:(x,o)=>invoke('read',x,o)});
}
