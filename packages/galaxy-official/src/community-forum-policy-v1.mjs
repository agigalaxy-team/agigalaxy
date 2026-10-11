import * as z from 'zod/v4';
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {digest} from './shared/digest.mjs';

const quota=z.strictObject(Object.fromEntries(['post','version','reply','report'].map(key=>[key,z.number().int().min(1).max(100000)])));
export const forumPolicySchema=z.strictObject({version:z.literal('forum-quota/1'),new:quota,normal:quota,
 maxPermissionSeconds:z.number().int().min(60).max(2592000),maxGovernanceHideSeconds:z.number().int().min(60).max(86400),
 accountForumMaxBytes:z.number().int().min(65536).max(8388608),maxTitleCodePoints:z.number().int().min(1).max(160),
 maxBodyCodePoints:z.number().int().min(1).max(8000),maxReplyCodePoints:z.number().int().min(1).max(2000),maxReportCodePoints:z.number().int().min(1).max(1600),
 maxLinks:z.number().int().min(0).max(8),maxLinkCodePoints:z.number().int().min(1).max(2048),maxPayloadBytes:z.number().int().min(4096).max(49152),
 maxAppeals:z.number().int().min(1).max(3),maxReportEvents:z.number().int().min(4).max(100),dailyUsageDays:z.number().int().min(1).max(30),auditDays:z.number().int().min(1).max(180),
});
export const defaultForumPolicy=Object.freeze(forumPolicySchema.parse({version:'forum-quota/1',new:{post:3,version:6,reply:30,report:5},normal:{post:12,version:24,reply:120,report:20},
 maxPermissionSeconds:2592000,maxGovernanceHideSeconds:86400,accountForumMaxBytes:2097152,maxTitleCodePoints:160,maxBodyCodePoints:8000,maxReplyCodePoints:2000,maxReportCodePoints:1600,
 maxLinks:8,maxLinkCodePoints:2048,maxPayloadBytes:49152,maxAppeals:3,maxReportEvents:100,dailyUsageDays:30,auditDays:180}));
export function forumPolicyHash(policy){return digest(JSON.stringify(forumPolicySchema.parse(policy)));}
export async function loadForumPolicy(path){
 if(!path)return forumPolicySchema.parse(defaultForumPolicy);
 if(!isAbsolute(path))throw new Error('Absolute forum policy path required');
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error('Invalid forum policy file');
 return forumPolicySchema.parse(JSON.parse(await readFile(path,'utf8')));
}
