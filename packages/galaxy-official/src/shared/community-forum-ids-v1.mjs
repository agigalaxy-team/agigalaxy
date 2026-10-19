import * as z from 'zod/v4';
import {forumWriteSpec} from './community-forum-v1-schema.mjs';
import {ServiceError} from './service-error.mjs';
import {stableJson,sha256Hex} from './web-primitives.mjs';

// The canonical, 32-character Galaxy GUID v1 grammar. No Node-only core import.
const subject=z.string().regex(/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
const account=z.uuid();
export function forumActorKey(actor){
 if(actor.kind==='official-account'&&account.safeParse(actor.accountId).success)return `account:${actor.accountId}`;
 if(subject.safeParse(actor.subjectId).success)return actor.subjectId;
 throw new ServiceError('invalid_forum_subject');
}
export function forumActorOwns(actor,row){
 if(!row)return false;
 if(actor.kind==='official-account'||actor.accountAuthorized)return !!actor.accountId&&row.account_id===actor.accountId;
 return !!actor.subjectId&&row.subject_id===actor.subjectId;
}
const generated={
 'create-post':['postId','versionId'],'publish-version':['versionId'],'create-reply':['replyId'],
 'create-report':['reportId'],supplement:['governanceEventId'],'withdraw-report':['governanceEventId'],
 appeal:['governanceEventId'],resolve:['governanceEventId'],
 'create-section':['sectionId'],
};
const omit=(payload,keys)=>Object.fromEntries(Object.entries(payload).filter(([key])=>!keys.includes(key)));

async function locator(kind,operationKind,subjectId,payload,crypto){
 const owner=subjectId.startsWith('account:')?{actor:{kind:'account',accountId:subjectId.slice(8)}}:{subjectId};
 const hex=await sha256Hex(stableJson({protocol:'galaxy-community-forum-locator',version:1,kind,operationKind,...owner,payload}),crypto);
 // RFC 9562 UUIDv8: 128 digest bits with six version/variant bits replaced.
 // The locator has 122 effective hash bits, not 256-bit collision strength.
 const chars=hex.slice(0,32).split('');chars[12]='8';chars[16]=((Number.parseInt(chars[16],16)&3)|8).toString(16);
 const value=chars.join('');return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}

/** Derive IDs only when preparing a new operation, before signing/persisting it. */
export async function bindForumIds(kind,subjectId,input,crypto=globalThis.crypto){
 if(!subject.safeParse(subjectId).success&&!(typeof subjectId==='string'&&subjectId.startsWith('account:')&&account.safeParse(subjectId.slice(8)).success))throw new ServiceError('invalid_forum_subject');
 const payload=forumWriteSpec(kind,input).schema.parse(input);
 if(kind==='create-post'){
  payload.postId=await locator('post',kind,subjectId,omit(payload,['postId','versionId']),crypto);
  payload.versionId=await locator('post-version',kind,subjectId,omit(payload,['versionId']),crypto);
 }else if(kind==='publish-version')payload.versionId=await locator('post-version',kind,subjectId,omit(payload,['versionId']),crypto);
 else if(kind==='create-reply')payload.replyId=await locator('reply',kind,subjectId,omit(payload,['replyId']),crypto);
 else if(kind==='create-report')payload.reportId=await locator('report',kind,subjectId,omit(payload,['reportId']),crypto);
 else if(kind==='create-section')payload.sectionId=await locator('section',kind,subjectId,omit(payload,['sectionId']),crypto);
 else if(generated[kind])payload.governanceEventId=await locator('governance-event',kind,subjectId,omit(payload,['governanceEventId']),crypto);
 return payload;
}

/** Independently validate a previously prepared payload; never repair caller IDs. */
export async function assertForumIds(kind,subjectId,input,crypto=globalThis.crypto){
 const bound=await bindForumIds(kind,subjectId,input,crypto);
 if((generated[kind]??[]).some(key=>input[key]!==bound[key]))throw new ServiceError('forum_locator_mismatch',409);
}
