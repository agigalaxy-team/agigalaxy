import { postPublicJson, validatePublicUrl } from './public-fetch.mjs';
import { notificationQuerySchema, notificationSettingsSchema, notificationIdSchema, notificationArchiveSchema } from './shared/notifications-schema.mjs';
export function createNotificationsClient({ endpoint, sessions, send = postPublicJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid notifications configuration.');
  async function invoke(path, input, valid, signal) {
    signal?.throwIfAborted(); const actor = await sessions.readAuthorization(endpoint);
    if (!actor?.scopes.includes('notifications')) throw new Error('Notifications authorization required.');
    const check = async () => {
      signal?.throwIfAborted(); if (!await sessions.isAuthorizationCurrent(actor) || !sessions.matchesAuthorization(actor)) throw new Error('Notifications authorization changed.');
    };
    try {
      await check(); const result = await send(endpoint + path, { bodyJson: JSON.stringify(input), credential: actor.credential, signal, maxBytes: 1048576 });
      await check(); if (!valid(result)) throw new Error('Invalid notifications response.'); return result;
    } catch (error) { if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(actor,'remote-rejected'); throw error; }
  }
  const validPreferences = value => value && notificationSettingsSchema.safeParse(value.settings).success && Number.isInteger(value.revision) && value.revision >= 0;
  return Object.freeze({
    query(input = {}, { signal } = {}) { const query = notificationQuerySchema.parse(input);
      return invoke('/v1/notifications/query', query, value => value && Array.isArray(value.items) && value.items.length <= query.limit
        && value.items.every(item => notificationIdSchema.safeParse(item.id).success) && typeof value.enabled === 'boolean'
        && (value.nextAfter === null || notificationIdSchema.safeParse(value.nextAfter).success), signal); },
    preferences(_input = {}, { signal } = {}) { return invoke('/v1/notifications/preferences/read', {}, validPreferences, signal); },
    save(input, { signal } = {}) { notificationSettingsSchema.parse(input.settings);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('Invalid preference revision.');
      return invoke('/v1/notifications/preferences/save', input, validPreferences, signal); },
    markRead(id, { signal } = {}) { notificationIdSchema.parse(id);
      return invoke('/v1/notifications/read', { id }, value => value?.id === id && value.read === true, signal); },
    archive(input, { signal } = {}) { const query = notificationArchiveSchema.parse(input);
      return invoke('/v1/notifications/archive', query, value => validPreferences(value) && value.archiveSupported === true
        && value.archivedBefore === new Date(query.before*1000).toISOString()
        && Number.isInteger(value.removedReadMarkers) && value.removedReadMarkers >= 0, signal); }
  });
}
