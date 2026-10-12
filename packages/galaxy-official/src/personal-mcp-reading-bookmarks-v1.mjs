import {readingBookmarkCommandSchema,readingBookmarkStatusSchema,readingBookmarkQuerySchema,readingBookmarkReceiptSchema} from './shared/reading-bookmarks-v1-schema.mjs';

export function readingBookmarkToolDefinitions(services,actor){
 const bookmarks=services.readingBookmarks;if(!bookmarks)return {};
 const tool=(inputSchema,description,run,write=false)=>({scope:'binding',inputSchema,description,run,write});
 return {
  galaxy_bookmarks:tool(readingBookmarkQuerySchema,
   'Find the connected subject’s private saved posts, exact method versions, projects or people. Each source is read with its current permission. Unavailable references remain removable; never reconstruct a missing body from old results. Saving does not follow updates, infer interests or create work.',
   input=>bookmarks.query(actor,input)),
  galaxy_bookmark_status:tool(readingBookmarkStatusSchema,
   'Read the current private saved state of one exact object reference. This state grants no access to the source.',
   input=>bookmarks.status(actor,input)),
  galaxy_bookmark_command:tool(readingBookmarkCommandSchema,
   'Save or remove one private reference at the user’s request. Use the current revision and persist the original operation ID before sending. Reconcile an unknown result before retrying; replaying an old acknowledged save cannot override a later removal.',
   input=>bookmarks.command(actor,input),true),
  galaxy_bookmark_receipt:tool(readingBookmarkReceiptSchema,
   'Recover the connected subject’s original bookmark operation by exact ID and payload hash. The receipt is historical; read current saved state before presenting the result.',
   input=>bookmarks.receipt(actor,input)),
 };
}
