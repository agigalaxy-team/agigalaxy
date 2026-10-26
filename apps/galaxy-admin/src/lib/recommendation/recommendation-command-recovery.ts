import {settingsReceiptResult} from "../use-settings-receipt-recovery";

type OriginalIntent=Readonly<{path:string;body:Record<string,unknown>}>;
export type RecommendationRecovered={recovered:true;operationId:string;kind:'policy'|'theme';version:number;themeKey:string;themeId:string|null};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The existing owner-only endpoint returns a ledger projection, never a full
 * save ACK. Missing/unknown records cannot authorize another POST. */
export function recommendationRecoveryReceipt(intent:OriginalIntent,value:unknown):RecommendationRecovered|null{
 const kind=intent.path==='/v1/operations/recommendation/policy'?'policy':intent.path==='/v1/operations/recommendation/themes'?'theme':null;
 const operationId=intent.body.operationId,expectedVersion=intent.body.expectedVersion;
 if(!kind||typeof operationId!=='string'||!uuid.test(operationId)||typeof expectedVersion!=='number'||!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw Error('Invalid original recommendation intent');
 const receipt=settingsReceiptResult('recommendation',{operationId,kind},value);
 if(!receipt)return null;
 const result=receipt.result,version=result?.version;
 if(!result||typeof version!=='number'||!Number.isSafeInteger(version)||version!==expectedVersion+1||typeof result.themeKey!=='string')throw Error('Different recommendation version');
 if(kind==='policy'){
  if(typeof intent.body.themeKey!=='string'||result.themeKey!==intent.body.themeKey)throw Error('Different recommendation target');
  return{recovered:true,operationId,kind,version,themeKey:result.themeKey,themeId:null};
 }
 const themeId=result.themeId;
 if(typeof themeId!=='string'||!uuid.test(themeId)||result.themeKey!=='theme:'+themeId||intent.body.themeId!=null&&intent.body.themeId!==themeId)throw Error('Different recommendation theme');
 return{recovered:true,operationId,kind,version,themeKey:result.themeKey,themeId};
}
