const base = 'https://galaxy.invalid';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function forumVersionPath(postId, versionId, replyId = null) {
  if (!uuid(postId) || !uuid(versionId) || replyId !== null && !uuid(replyId)) return null;
  return `/app/community/posts/${postId}/versions/${versionId}${replyId ? '#reply-' + replyId : ''}`;
}

export function forumReplyPath(replyId) {
  return uuid(replyId) ? `/app/community/replies/${replyId}` : null;
}

// These are exact local navigation locators, never an authority to reuse a
// source body or a replacement for Task.parentTaskId.
export function normalizeForumOrigin(value) {
  if (!value || !uuid(value.postId) || !uuid(value.versionId)) return null;
  const fallback = forumVersionPath(value.postId, value.versionId);
  if (!fallback) return null;
  let returnTo = fallback;
  try {
    if (typeof value.returnTo === 'string' && value.returnTo.startsWith('/') && !value.returnTo.startsWith('//')) {
      const target = new URL(value.returnTo, base);
      if (target.origin === base && target.pathname === fallback && !target.search
        && (!target.hash || /^#reply-[0-9a-f-]{36}$/i.test(target.hash) && uuid(target.hash.slice(7))))
        returnTo = target.pathname + target.hash;
    }
  } catch { /* An invalid return path never changes the selected source. */ }
  return { postId: value.postId, versionId: value.versionId, returnTo };
}

export function forumTaskPath(value) {
  const origin = normalizeForumOrigin(value);
  if (!origin) return null;
  const query = new URLSearchParams({ forumPost: origin.postId, forumVersion: origin.versionId, forumReturn: origin.returnTo });
  return '/app/publish?' + query;
}

export function forumTaskLocator(value) {
  try {
    const target = new URL(value, base);
    if (target.origin !== base || target.pathname !== '/app/publish') return null;
    return normalizeForumOrigin({ postId: target.searchParams.get('forumPost'), versionId: target.searchParams.get('forumVersion'), returnTo: target.searchParams.get('forumReturn') });
  } catch { return null; }
}
