import {operationsVisibilityWithin} from './operations-content-visibility.mjs';

// Shared by current permission reads, forum bodies, references and attachments.
// Taking down a post stops its versions and the replies under that post too.
export async function forumOperationsHiddenWithin(db,{endpoint,kind,id,postId,now}){
 const own=await operationsVisibilityWithin(db,{endpoint,kind:kind==='post'?'forum-post':'forum-reply',id,now});
 if(own.hidden)return true;
 return kind==='reply'&&!!postId&&(await operationsVisibilityWithin(db,{endpoint,kind:'forum-post',id:postId,now})).hidden;
}
