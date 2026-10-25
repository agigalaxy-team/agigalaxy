import {summaryContentSchema} from "../../shared/personal-summary-schema.mjs";
import {failure,uuid} from './helpers.mjs';

// The existing strict owner-only cloud response contract. No server response grants a new local owner or source permission.
export function validatePersonalSummaryCloudView(value,{summaryId,roomId,listed=false}={}){
 if(!value||!uuid(value.summaryId)||summaryId&&value.summaryId!==summaryId||!Number.isSafeInteger(value.revision)||value.revision<0
   ||value.audience!=='owner-only'||value.sharedToRoom!==false||!Array.isArray(value.conflicts)||value.conflicts.some(version=>!version||typeof version!=='object'||Array.isArray(version))
   ||value.current===undefined||value.current!==null&&(typeof value.current!=='object'||Array.isArray(value.current))
   ||(listed||value.current||value.conflicts.length)&&!uuid(value.roomId)||value.roomId!==undefined&&!uuid(value.roomId)||roomId&&value.roomId!==roomId)
  throw failure('summary_cloud_response_mismatch');
 for(const version of [value.current,...value.conflicts].filter(Boolean)){
  if(version.summaryId!==value.summaryId||version.roomId!==undefined&&version.roomId!==value.roomId||!uuid(version.versionId)||!Number.isSafeInteger(version.revision)||version.revision<0
    ||!['current','conflict','expired','deleted','superseded'].includes(version.state))throw failure('summary_cloud_response_mismatch');
  if(['current','conflict'].includes(version.state)){if(!summaryContentSchema.safeParse(version.content).success)throw failure('summary_cloud_response_mismatch');}
  else if(!version.content||Object.keys(version.content).length)throw failure('summary_cloud_response_mismatch');
 }
 if(value.conflicts.some(version=>version.state!=='conflict')||value.current&&value.current.state==='conflict')throw failure('summary_cloud_response_mismatch');
 return value;
}
