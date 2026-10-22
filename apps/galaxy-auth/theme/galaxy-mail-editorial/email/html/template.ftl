<#ftl output_format="HTML" auto_esc=true>
<#macro emailLayout title="" category="" preheader="" brandName=(brand!"AGI Galaxy")>
<!doctype html>
<html lang="${(locale.language)!msg("galaxyMailLanguage")}" dir="${(ltr!true)?then("ltr", "rtl")}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title?has_content?then(title, brandName)}</title><style>@media only screen and (max-width:480px){
  .galaxy-mail-outer{padding:20px 8px 32px!important}
  .galaxy-mail-paper{padding:26px 22px!important}
  .galaxy-mail-brand{font-size:17px!important}
  .galaxy-mail-mark{padding-right:9px!important}
  .galaxy-mail-category{max-width:60px!important;padding-left:8px!important}
  .galaxy-mail-title{font-size:25px!important;line-height:36px!important}
  .galaxy-mail-code-cell{padding:17px!important}
}</style></head>
<body style="margin:0;padding:0;background-color:#f7f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none!important;font-size:1px;line-height:1px;color:#f7f8fa;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#f7f8fa;">
<tr><td class="galaxy-mail-outer" align="center" style="padding:24px 12px 32px;"><!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:600px;margin:0 auto;background-color:#ffffff;border:1px solid #e4e7eb;border-radius:4px;border-collapse:separate;border-spacing:0;">
<tr><td class="galaxy-mail-paper" style="padding:30px 32px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
<tr><td style="border-bottom:2px solid #eccfdc;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
<tr><td style="padding-bottom:21px;vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td class="galaxy-mail-mark" width="32" style="padding-right:11px;vertical-align:middle;"><img src="https://auth.agigalaxy.org/assets/img/galaxy-mail-logo.png?v=mail-letterhead-20261020" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border:0;outline:none;text-decoration:none;"></td><td class="galaxy-mail-brand" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:18px;line-height:28px;font-weight:600;letter-spacing:-.3px;color:#202735;white-space:nowrap;vertical-align:middle;">${brandName}</td></tr></table></td><td class="galaxy-mail-category" align="right" style="padding:0 0 21px 12px;vertical-align:middle;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:12px;line-height:20px;color:#68717f;">${category?has_content?then(category, msg("galaxyMailDefaultCategory"))}</td></tr>
</table></td></tr><tr><td style="padding:28px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:25px;color:#495363;overflow-wrap:anywhere;"><#nested></td></tr><tr><td class="galaxy-mail-contact" style="padding-bottom:22px;"><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:25px;color:#495363;font-size:12px;line-height:20px;color:#68717f;">${msg("galaxyMailAutomatedNotice")}</p><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:25px;color:#495363;padding-top:3px;font-size:12px;line-height:20px;color:#68717f;">${msg("galaxyMailContactTeam")}：<a href="mailto:team@agigalaxy.org" style="color:#8f4363;text-decoration:underline;">team@agigalaxy.org</a></p></td></tr><tr><td style="padding-top:20px;border-top:1px solid #e9ecf0;"><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:25px;color:#495363;font-size:13px;line-height:20px;font-weight:600;color:#495363;">${brandName}</p><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:25px;color:#495363;padding-top:7px;font-size:12px;line-height:20px;color:#68717f;"><a href="https://agigalaxy.org/" style="color:#8f4363;text-decoration:underline;">agigalaxy.org</a><span style="padding:0 9px;color:#68717f;">·</span><a href="https://agigalaxy.org/privacy/" style="color:#8f4363;text-decoration:underline;">${msg("galaxyMailPrivacy")}</a></p></td></tr>
</table></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]--></td></tr>
</table>
</body>
</html>
</#macro>
