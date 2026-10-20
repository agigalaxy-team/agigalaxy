<#ftl output_format="HTML" auto_esc=true>
<#macro emailLayout title="" category="" preheader="" brandName=(brand!"AGI Galaxy")>
<!doctype html>
<html lang="${(locale.language)!msg("galaxyMailLanguage")}" dir="${(ltr!true)?then("ltr", "rtl")}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title?has_content?then(title, brandName)}</title></head>
<body style="margin:0;padding:0;background-color:#f8f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none!important;font-size:1px;line-height:1px;color:#f8f7f9;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#f8f7f9;">
<tr><td align="center" style="padding:24px 12px 32px;"><!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;max-width:600px;margin:0 auto;background-color:#ffffff;border:1px solid #e7e2e6;">
<tr><td style="padding:29px 32px 28px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
<tr><td style="border-bottom:2px solid #e6c2d6;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
<tr><td style="padding-bottom:19px;"><span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:18px;line-height:28px;font-weight:650;letter-spacing:-.5px;color:#29242a;">${brandName}</span></td><td align="right" style="padding-bottom:19px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:12px;line-height:20px;color:#8c7e87;">${category?has_content?then(category, msg("galaxyMailDefaultCategory"))}</td></tr>
</table></td></tr><tr><td style="padding:28px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:26px;color:#605a60;"><#nested></td></tr><tr><td style="padding-top:22px;border-top:1px solid #eee8ec;"><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:26px;color:#605a60;font-size:13px;line-height:23px;font-weight:600;color:#63545f;">${brandName}</p><p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;font-size:15px;line-height:26px;color:#605a60;font-size:12px;line-height:22px;color:#91898f;">agigalaxy.org</p></td></tr>
</table></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]--></td></tr>
</table>
</body>
</html>
</#macro>
