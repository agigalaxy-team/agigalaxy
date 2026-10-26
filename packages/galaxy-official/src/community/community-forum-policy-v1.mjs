import {forumPolicySchema,defaultForumPolicy} from "../shared/policies/forum-quota.mjs";
export {forumPolicySchema,defaultForumPolicy,forumPolicyHash} from "../shared/policies/forum-quota.mjs";
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

export async function loadForumPolicy(path){
 if(!path)return forumPolicySchema.parse(defaultForumPolicy);
 if(!isAbsolute(path))throw new Error('Absolute forum policy path required');
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error('Invalid forum policy file');
 return forumPolicySchema.parse(JSON.parse(await readFile(path,'utf8')));
}
