import * as z from 'zod/v4';
import {digest} from "../shared/digest.mjs";
import {ServiceError} from "../shared/service-error.mjs";

const cursorSchema = z.strictObject({
  version: z.literal(1),
  filtersHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    .refine(value => Number.isFinite(Date.parse(value))),
  id: z.uuid(),
});

/**
 * A cursor is a page location, never reading authority.
 * @param {{after?:string,order?:'published'|'id',topic?:string,query:string}} input
 * @param {string|null} [ownerId]
 */
export function forumPageFor(input, ownerId = null) {
  const uuidAfter = input.after !== undefined && z.uuid().safeParse(input.after).success;
  const order = input.order ?? (uuidAfter ? 'id' : 'published');
  if (order === 'id') {
    if (input.topic !== undefined || input.sectionId !== undefined || input.query !== '' || input.after !== undefined && !uuidAfter)
      throw new ServiceError('forum_cursor_mismatch');
    return {order, afterId: input.after ?? null, afterAt: null, filtersHash: null};
  }
  if (uuidAfter) throw new ServiceError('forum_cursor_mismatch');
  const parts=[ownerId,input.topic??null,input.query.toLocaleLowerCase('en-US'),order];if(input.sectionId!==undefined)parts.push(input.sectionId);
  const filtersHash = digest(JSON.stringify(parts));
  if (input.after === undefined) return {order, afterId: null, afterAt: null, filtersHash};
  try {
    if (!/^fp1\.[A-Za-z0-9_-]+$/.test(input.after)) throw Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.after.slice(4), 'base64url').toString('utf8')));
    if (cursor.filtersHash !== filtersHash) throw Error();
    return {order, afterId: cursor.id, afterAt: cursor.createdAt, filtersHash};
  } catch {
    throw new ServiceError('forum_cursor_mismatch');
  }
}

export function forumPageAfter(page, row) {
  if (page.order === 'id') return row.id;
  const cursor = {version: 1, filtersHash: page.filtersHash, createdAt: new Date(row.created_at).toISOString(), id: row.id};
  return 'fp1.' + Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Match only an already currently readable projection, never expired cached text. */
export function forumMatchesQuery(view, input) {
  if (view.availability !== 'available' || !view.payload) return false;
  if (input.topic !== undefined && view.topic !== input.topic) return false;
  if (!input.query) return true;
  const query = input.query.toLocaleLowerCase('en-US');
  return [view.payload.title, view.payload.body].some(value => typeof value === 'string' && value.toLocaleLowerCase('en-US').includes(query));
}
