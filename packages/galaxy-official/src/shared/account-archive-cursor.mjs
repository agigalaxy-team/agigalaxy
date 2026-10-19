import {z} from 'zod';
import {ServiceError} from './service-error.mjs';

export const archiveAfterSchema=z.union([z.uuid(),z.string().max(512).regex(/^ac1\.[A-Za-z0-9_-]+$/)]);
const cursorSchema=z.strictObject({version:z.literal(1),accountId:z.uuid(),originSubjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/).nullable(),
 createdAt:z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/).refine(value=>Number.isFinite(Date.parse(value))),id:z.uuid()});

// A position carries no reading authority. The list query still applies the
// current account and original ID restrictions, even if the anchor was erased.
export function archiveCursorFor(value,{accountId,originSubjectId}){
 if(value===undefined)return null;
 if(z.uuid().safeParse(value).success)return {id:value,legacy:true};
 try{
  archiveAfterSchema.parse(value);
  const cursor=cursorSchema.parse(JSON.parse(Buffer.from(value.slice(4),'base64url').toString('utf8')));
  if(cursor.accountId!==accountId||cursor.originSubjectId!==originSubjectId)throw Error();
  return {id:cursor.id,created_at:cursor.createdAt,legacy:false};
 }catch{throw new ServiceError('invalid_archive_cursor');}
}
export function archiveCursorAfter(row,{accountId,originSubjectId}){
 const cursor={version:1,accountId,originSubjectId,createdAt:new Date(row.created_at).toISOString(),id:row.id};
 return 'ac1.'+Buffer.from(JSON.stringify(cursor),'utf8').toString('base64url');
}
