import * as z from 'zod/v4';
import {forumPostsQuerySchema,forumRepliesQuerySchema,forumVersionsQuerySchema} from './shared/community-forum-v1-schema.mjs';
import {forumTopics,forumUnclassifiedTopic} from './shared/community-forum-topics-v1.mjs';

// These reads use the same live publication permissions as the forum. A saved
// reference, old tool response or open browser page never extends that grant.
export function communityToolDefinitions(services,actor){
 const forum=services.forum;
 if(!forum)return {};
 const tool=(scope,inputSchema,description,run)=>({scope,inputSchema,description,run,write:false});
 return {
  galaxy_community_topics:tool('binding',z.strictObject({}),
   'Read the available community topics and their meaning before browsing or preparing a post. Existing posts without a topic remain honestly unclassified. These are navigation choices, not inferred personal interests.',
   ()=>({items:forumTopics,legacyTopic:forumUnclassifiedTopic})),
  galaxy_community_query:tool('binding',forumPostsQuerySchema,
   'Browse currently public community posts by topic or search their title and body. Use the returned cursor with the same filters to continue; an empty scanned page with a continuation is not the end. A topic is this browsing choice, not a permanent personal interest. No messages or publications are sent.',
   input=>forum.query(input)),
  galaxy_community_read:tool('binding',z.strictObject({postId:z.uuid(),versionId:z.uuid().optional()}),
   'Read a community post or an exact published version with its current permission, authored body and original dates. Use the exact version when discussing or citing it; obtain replies separately. If the source is unavailable, preserve only the reference and do not reconstruct its body from earlier responses.',
   input=>input.versionId?forum.getVersion(input.postId,input.versionId):forum.getPost(input.postId)),
  galaxy_community_replies:tool('binding',forumRepliesQuerySchema,
   'Read current public replies to the selected exact post version. Continue with the returned cursor. A reply is ordinary discussion and does not create a task, commitment or separate result.',
   input=>forum.replies(input)),
  galaxy_community_versions:tool('binding',z.strictObject({postId:z.uuid(),...forumVersionsQuerySchema.shape}),
   'Read the currently available versions of this community post. Keep authorship, original publication and version changes distinct; a newer version does not rewrite the historical one.',
   ({postId,...input})=>forum.versions(postId,input)),
  galaxy_community_owned:tool('assistance',forumPostsQuerySchema,
   'Find posts authored by the connected subject, with currently permitted summaries and management metadata. Missing bodies remain unavailable; ownership metadata is not permission to restore old content.',
   input=>forum.owned(actor,input)),
 };
}
