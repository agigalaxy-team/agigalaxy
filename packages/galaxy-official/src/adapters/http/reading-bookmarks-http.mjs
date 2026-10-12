import {body, authenticate} from './request.mjs';

export async function dispatchReadingBookmarks({readingBookmarks, access, request, requestId, url, send, consumeSearchPage = () => {}}) {
  const matched = /^\/v2\/reading-bookmarks\/(status|command|query|receipt)$/.exec(url.pathname);
  if (!readingBookmarks || request.method !== 'POST' || !matched) return false;
  const method = matched[1], actor = {...await authenticate(request, access, 'binding'), httpRequestId: requestId}, input = await body(request);
  if (method === 'query') consumeSearchPage(actor, input.after);
  send(200, await readingBookmarks[method](actor, input));
  return true;
}
