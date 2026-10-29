import type * as z from 'zod/v4';
import type {peeringAgreementSchema,peeringEventSchema,peeringPartySchema,peeringSourceSchema} from "../../../../galaxy-contracts/src/hub-peering-v2-schema.mjs";
import type {HubIntake} from './hub-workspace-types';

export type PeeringEvent=z.infer<typeof peeringEventSchema>;
export type PeeringSource=z.infer<typeof peeringSourceSchema>;
export type PeeringParty=z.infer<typeof peeringPartySchema>;
export type PeeringAgreement=z.infer<typeof peeringAgreementSchema>;
export type PeeringMaterial={signed?:string;projection?:Record<string,string|number|string[]|null>;synthetic?:boolean|null;expiresAt?:number;subjectId?:string};
export type PeeringPreview={source:PeeringSource;projection:PeeringMaterial;agreementVersion:number;peer:string;maxExpiresAt:number};
export type PeeringConnection={agreementId:string;peer:string;expiresAt:number};
export type PeeringWork={taskId?:string;caseId?:string;kind?:string;title?:string;summary?:string;request?:{title?:string}};
export type PeeringOwned<T extends PeeringEvent>={id:string;version:number;state:string;expiresAt:number;record:T|null};
export type PeeringQueryItem=PeeringMaterial&{grantId:string;state:string;subjectId?:string};
export type PeeringQuery={state?:string;expiresAt?:number;items:PeeringQueryItem[];nextCursor:number;deferredRecheck?:string[];hasMore?:boolean;sourceGroups?:{conflicts?:unknown[]}[]};
type Page<T>={items:T[];nextCursor:string|null};
export type PeeringApi={
 (method:'connections',input:{hubId:string;limit:number;after?:string}):Promise<Page<PeeringConnection>>;
 (method:'sources',input:{hubId:string;kind:string;parentId?:string;limit:number;after?:string}):Promise<Page<{source:PeeringSource;eventType:string;synthetic:boolean|null}>>;
 (method:'preview',input:{hubId:string;agreementId:string;source:PeeringSource}):Promise<PeeringPreview>;
 (method:'read',input:{hubId:string;agreementId:string}):Promise<{state:string;version:number;agreement:PeeringAgreement|null}>;
 (method:'list',input:{hubId:string;kind:'agreements';limit:number;after?:string}):Promise<Page<PeeringOwned<Extract<PeeringEvent,{kind:'peer-approve'}>>>>;
 (method:'list',input:{hubId:string;kind:'grants';limit:number;after?:string}):Promise<Page<PeeringOwned<Extract<PeeringEvent,{kind:'source-grant'}>>>>;
 (method:'party',input:{hubId:string}):Promise<{party:PeeringParty}>;
 (method:'query',input:{hubId:string;agreementId:string;queryId:string;after:number;recheck:string[]}):Promise<PeeringQuery>;
};
export type PeeringInput={tab:string;agreementId:string;kind:string;parentId:string;source:PeeringSource|null;fields:Extract<PeeringSource,{kind:'contribution-summary'}>['fields'];readers:string[];extraReaders:string;peopleQuery:string;peerParty:string;agreementText:string};
export type PeeringChoice={event:PeeringEvent;material?:PeeringMaterial;peer?:string;revision?:string|null};

/** Drop only the expired thread bodies; their accurate history and locators remain. */
export function currentHubIntakes(items:HubIntake[],now:number){
 return items.map(item=>item.expiresAt*1000>now?item:{...item,availableActions:[],messages:item.messages.map(message=>{
  const {text:_text,title:_title,...record}=message;return {...record,contentAvailable:false};
 })});
}
