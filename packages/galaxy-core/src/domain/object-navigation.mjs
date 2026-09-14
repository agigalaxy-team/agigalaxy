const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kinds = { task: 'tasks', room: 'rooms', case: 'cases', profile: 'profiles', honor: 'honors' };
const settings = new Set(['identity', 'privacy', 'connections', 'notifications']);
export function objectPath({ kind, id, section } = {}) {
  if (kind === 'workspace') return '/app/';
  if (kind === 'settings' && settings.has(id)) return `/app/settings/${id}`;
  if (!kinds[kind] || typeof id !== 'string' || !(kind === 'profile' ? /^GUID[0-9A-Z]{28}$/.test(id) : uuid.test(id))) throw new Error('Invalid Galaxy object location.');
  if (section !== undefined && !['responses', 'suggestions', 'history', 'summary', 'messages', 'participation'].includes(section)) throw new Error('Invalid object section.');
  return `/app/${kinds[kind]}/${id}${section ? `?section=${section}` : ''}`;
}
export function objectUrl(websiteOrigin, object) {
  const origin = new URL(websiteOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== websiteOrigin || origin.username || origin.password) throw new Error('Configured HTTPS website origin required.');
  return new URL(objectPath(object), websiteOrigin).href;
}
// A browser opening result only describes navigation, never a business write.
export async function openGalaxyObject({ websiteOrigin, object, open, originWorkRef, saveReturn }) {
  const url = objectUrl(websiteOrigin, object);
  if (originWorkRef !== undefined) await saveReturn?.({ object, originWorkRef });
  const opened = await open(url);
  return { surface: 'browser', targetPath: objectPath(object), opened: opened === true,
    businessMutation: false, returnMode: 'mcp-refresh', embeddedUi: 'unverified' };
}
