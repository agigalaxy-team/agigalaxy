<#ftl output_format="HTML" auto_esc=true>
<#macro emailLayout title="" category="" preheader="" brandName=(brand!"AGI Galaxy")>
<!doctype html>
<html lang="${(locale.language)!msg("galaxyMailLanguage")}" dir="${(ltr!true)?then("ltr", "rtl")}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title?has_content?then(title, brandName)}</title><style>@media only screen and (max-width:480px){
  .galaxy-mail-outer{padding:19px 8px!important}
  .galaxy-mail-paper{padding:32px 23px!important}
  .galaxy-mail-brand{font-size:16px!important}
  .galaxy-mail-mark{padding-right:8px!important}
  .galaxy-mail-category{max-width:60px!important;padding-left:8px!important}
  .galaxy-mail-title{font-size:22px!important;line-height:32px!important}
  .galaxy-mail-code-cell{padding:17px!important}
}</style></head>
<body style="margin:0;padding:0;background-color:#f7f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none!important;font-size:1px;line-height:1px;color:#f7f8fa;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#f7f8fa;">
<tr><td class="galaxy-mail-outer" align="center" style="padding:24px 12px 32px;"><!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:600px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e5eb;border-radius:5px;border-collapse:separate;border-spacing:0;">
<tr><td class="galaxy-mail-paper" style="padding:32px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
<tr><td style="border-bottom:2px solid #ead3df;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
<tr><td style="padding-bottom:22px;vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td class="galaxy-mail-mark" width="27" style="padding-right:10px;vertical-align:middle;"><img src="https://auth.agigalaxy.org/assets/img/galaxy-mail-logo.png?v=mail-letterhead-20261020" width="27" height="27" alt="" style="display:block;width:27px;height:27px;border:0;outline:none;text-decoration:none;"></td><td class="galaxy-mail-brand" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:17px;line-height:26px;font-weight:600;letter-spacing:-.3px;color:#282a34;white-space:nowrap;vertical-align:middle;">${brandName}</td></tr></table></td><td class="galaxy-mail-category" align="right" style="padding:0 0 22px 12px;vertical-align:middle;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:11.5px;line-height:18px;color:#6d6e7b;">${category?has_content?then(category, msg("galaxyMailDefaultCategory"))}</td></tr>
</table></td></tr><tr><td style="padding:27px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:26.25px;color:#505361;overflow-wrap:anywhere;"><#nested></td></tr><tr><td class="galaxy-mail-contact" style="padding:25px 0;"><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:26.25px;color:#505361;font-size:12px;line-height:21px;color:#6d6e7b;">${msg("galaxyMailAutomatedNotice")}</p><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:26.25px;color:#505361;padding-top:3px;font-size:12px;line-height:21px;color:#6d6e7b;">${msg("galaxyMailContactTeam")}：<a href="mailto:team@agigalaxy.org" style="color:#84516b;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere;">team@agigalaxy.org</a></p></td></tr><tr><td class="galaxy-mail-footer" align="center" style="padding-top:19px;border-top:1px solid #eee9ef;text-align:center;"><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:26.25px;color:#505361;font-size:11.5px;line-height:20px;color:#747481;text-align:center;"><a href="https://agigalaxy.org/how-it-works/" style="color:#747481;text-decoration:none;white-space:nowrap;">${msg("galaxyMailAbout")}</a><span style="padding:0 7px;color:#b7b5bf;">·</span><a href="https://agigalaxy.org/privacy/" style="color:#747481;text-decoration:none;white-space:nowrap;">${msg("galaxyMailPrivacy")}</a><span style="padding:0 7px;color:#b7b5bf;">·</span><a href="https://agigalaxy.org/docs/" style="color:#747481;text-decoration:none;white-space:nowrap;">${msg("galaxyMailGuide")}</a></p><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:26.25px;color:#505361;padding-top:6px;font-size:11.5px;line-height:20px;color:#747481;text-align:center;">© ${.now?string("yyyy")} ${brandName}</p></td></tr>
</table></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]--></td></tr>
</table>
</body>
</html>
</#macro>
