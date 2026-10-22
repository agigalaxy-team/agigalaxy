// Public brand identities selected by the site owner. Credentials and transport
// configuration belong to the sending service, never this shared renderer.
export const EMAIL_TEAM_ADDRESS = 'team@agigalaxy.org';
const identity = (label, address, automated) => Object.freeze({
  name: `AGI Galaxy ${label}`, address, replyTo: EMAIL_TEAM_ADDRESS, automated,
});
export const OFFICIAL_MAIL_IDENTITIES = Object.freeze({
  account: identity('账户', 'account@agigalaxy.org', true),
  notice: identity('通知', 'notice@agigalaxy.org', true),
  community: identity('社区', 'community@agigalaxy.org', true),
  updates: identity('更新', 'updates@agigalaxy.org', true),
  team: identity('团队', EMAIL_TEAM_ADDRESS, false),
});
export function officialMailIdentity(purpose) {
  if (!Object.hasOwn(OFFICIAL_MAIL_IDENTITIES, purpose)) throw new Error('Unknown official mail purpose.');
  return OFFICIAL_MAIL_IDENTITIES[purpose];
}
