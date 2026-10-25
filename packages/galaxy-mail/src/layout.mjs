// Stable public rendering API shared by auth themes and operations mail.
// Transport, credentials and storage remain in their caller-owned services.
export {EMAIL_TEAM_ADDRESS, OFFICIAL_MAIL_IDENTITIES, officialMailIdentity} from './identities.mjs';
export {EMAIL_FONT, EMAIL_MONO, EMAIL_LOGO_URL, escapeEmailText} from './rendering/common.mjs';
export {renderEmailLayout, renderGalaxyEmail, renderCodeEmail} from './rendering/messages.mjs';
export {keycloakEmailLayoutTemplates, keycloakEmailCodeTemplates, keycloakEmailThemeTemplates} from './keycloak/templates.mjs';
