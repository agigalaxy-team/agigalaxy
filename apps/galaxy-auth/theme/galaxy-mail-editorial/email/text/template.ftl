<#ftl output_format="plainText">
<#macro emailLayout title="" category="" preheader="" brandName=(brand!"AGI Galaxy")>
${brandName}

${category?has_content?then(category, msg("galaxyMailDefaultCategory"))}

<#nested>

${brandName}
https://agigalaxy.org/
${msg("galaxyMailPrivacy")}: https://agigalaxy.org/privacy/
</#macro>
