import * as z from 'zod/v4';
import {forumPostsQuerySchema,forumRepliesQuerySchema,forumVersionsQuerySchema} from './shared/community-forum-v1-schema.mjs';
import {forumTopics,forumUnclassifiedTopic} from './shared/community-forum-topics-v1.mjs';

// These reads use the same live publication permissions as the forum. A saved
// reference, old tool response or open browser page never extends that grant.
export function communityToolDefinitions(services,actor){
 const forum=services.forum;
 if(!forum)return {};
 const tool=(scope,inputSchema,description,run)=>({scope,inputSchema,description,run,write:false});
 const selected=input=>{const {accountId,...request}=input;return {request,reader:accountId?{...actor,accountId}:actor};};
 const account={accountId:z.uuid().optional()};
 return {
  galaxy_community_account_options:tool('binding',z.strictObject({}),
   'Read the real online accounts currently associated with this ID. Select an explicit target for account-scoped forum reads or actions; association does not grant unrelated account or ID permissions.',
   ()=>services.access.runAuthorized(actor,'binding',async db=>{const rows=await services.communityAccounts.availableWithin(db,actor);return {items:rows.map(row=>({id:row.id})),selectionRequired:rows.length>1};})),
  galaxy_community_topics:tool('binding',z.strictObject({}),
   'Read the available community topics and their meaning before browsing or preparing a post. Existing posts without a topic remain honestly unclassified. These are navigation choices, not inferred personal interests.',
   ()=>({items:forumTopics,legacyTopic:forumUnclassifiedTopic})),
  galaxy_community_query:tool('binding',forumPostsQuerySchema.extend(account),
   'Browse currently readable community posts by topic, member section or title/body. Select the exact associated account for account-scoped content. Continue with the same filters and account; querying sends no message or publication.',
   input=>{const {request,reader}=selected(input);return forum.query(request,reader);}),
  galaxy_community_read:tool('binding',z.strictObject({postId:z.uuid(),versionId:z.uuid().optional(),...account}),
   'Read a community post or an exact published version with its current permission, authored body and original dates. Use the exact version when discussing or citing it; obtain replies separately. If the source is unavailable, preserve only the reference and do not reconstruct its body from earlier responses.',
   input=>{const {request,reader}=selected(input);return request.versionId?forum.getVersion(request.postId,request.versionId,reader):forum.getPost(request.postId,reader);}),
  galaxy_community_replies:tool('binding',forumRepliesQuerySchema.extend(account),
   'Read current public replies to the selected exact post version. Continue with the returned cursor. A reply is ordinary discussion and does not create a task, commitment or separate result.',
   input=>{const {request,reader}=selected(input);return forum.replies(request,reader);}),
  galaxy_community_versions:tool('binding',z.strictObject({postId:z.uuid(),...forumVersionsQuerySchema.shape,...account}),
   'Read the currently available versions of this community post. Keep authorship, original publication and version changes distinct; a newer version does not rewrite the historical one.',
   input=>{const {request:{postId,...request},reader}=selected(input);return forum.versions(postId,request,reader);}),
  galaxy_community_owned:tool('assistance',forumPostsQuerySchema.extend(account),
   'Find posts authored by the connected subject, with currently permitted summaries and management metadata. Missing bodies remain unavailable; ownership metadata is not permission to restore old content.',
   input=>{const {request,reader}=selected(input);return forum.owned(reader,request);}),
 };
}
