import {codeBody} from '../rendering/common.mjs';
import {htmlLayout, textLayout} from '../rendering/frame.mjs';

const expression = value => '${' + value + '}';
const message = key => expression('msg("' + key + '")');
const actionMessage = (key, withBrand = false) => expression('msg("galaxyEmailCode' + key + '" + actionSuffix' + (withBrand ? ', brand' : '') + ')');
const purpose = '<#if purpose != "register" && purpose != "reset-password"><#stop "Unsupported account email purpose"></#if>\n<#assign actionSuffix = (purpose == "register")?then("Register", "Reset")>\n';

/** Compatible with the no-argument emailLayout macro in Keycloak 26.7.3. */
export function keycloakEmailLayoutTemplates() {
  const macro = '<#macro emailLayout title="" category="" preheader="" brandName=(brand!"AGI Galaxy")>\n';
  const category = expression('category?has_content?then(category, msg("galaxyMailDefaultCategory"))');
  return {
    html: '<#ftl output_format="HTML" auto_esc=true>\n' + macro + htmlLayout({
      language: expression('(locale.language)!msg("galaxyMailLanguage")'), direction: expression('(ltr!true)?then("ltr", "rtl")'),
      brand: expression('brandName'), category, title: expression('title?has_content?then(title, brandName)'),
      preheader: expression('preheader'), body: '<#nested>', aboutLabel: message('galaxyMailAbout'), privacyLabel: message('galaxyMailPrivacy'), guideLabel: message('galaxyMailGuide'), copyrightYear: expression('.now?string("yyyy")'),
      replyNotice: message('galaxyMailAutomatedNotice'), contactLabel: message('galaxyMailContactTeam'),
    }) + '\n</#macro>\n',
    text: '<#ftl output_format="plainText">\n' + macro + textLayout({brand: expression('brandName'), category,
      body: '<#nested>', aboutLabel: message('galaxyMailAbout'), privacyLabel: message('galaxyMailPrivacy'), guideLabel: message('galaxyMailGuide'), copyrightYear: expression('.now?string("yyyy")'), replyNotice: message('galaxyMailAutomatedNotice'), contactLabel: message('galaxyMailContactTeam')}) + '</#macro>\n',
  };
}

/** Build-time source for the selected theme, never real verification values. */
export function keycloakEmailCodeTemplates() {
  const call = '<#import "template.ftl" as layout>\n<@layout.emailLayout title=msg("galaxyEmailCodeTitle" + actionSuffix) category=msg("galaxyEmailCodePurpose" + actionSuffix) preheader=msg("galaxyEmailCodePreheader" + actionSuffix, brand) brandName=brand>\n';
  const body = codeBody({title: actionMessage('Title'), eyebrow: message('galaxyEmailCodeCodeLabel'),
    introduction: actionMessage('Introduction', true), instruction: actionMessage('Instruction'),
    code: expression('code'), expiry: expression('msg("galaxyEmailCodeExpiry", expiresInMinutes?c)'),
    safety: actionMessage('Safety')});
  const plain = [actionMessage('Title'), actionMessage('Introduction', true), actionMessage('Instruction'),
    expression('msg("galaxyEmailCodeTextCode", code)'), expression('msg("galaxyEmailCodeExpiry", expiresInMinutes?c)'),
    actionMessage('Safety')].join('\n\n');
  return {html: '<#ftl output_format="HTML" auto_esc=true>\n' + purpose + call + body + '\n</@layout.emailLayout>\n',
    text: '<#ftl output_format="plainText">\n' + purpose + call + plain + '\n</@layout.emailLayout>\n'};
}

/** Exact relative paths for the auth builder's selected email theme output. */
export function keycloakEmailThemeTemplates() {
  const layout = keycloakEmailLayoutTemplates(), code = keycloakEmailCodeTemplates();
  return {'html/template.ftl': layout.html, 'text/template.ftl': layout.text,
    'html/galaxy-email-code.ftl': code.html, 'text/galaxy-email-code.ftl': code.text};
}
