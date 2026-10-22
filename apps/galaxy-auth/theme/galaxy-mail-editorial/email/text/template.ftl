<#ftl output_format="plainText">
<#macro emailLayout title="" category="" preheader="" brandName=(brand!"AGI Galaxy")>
${brandName}

${category?has_content?then(category, msg("galaxyMailDefaultCategory"))}

<#nested>

${msg("galaxyMailAutomatedNotice")}
${msg("galaxyMailContactTeam")}: team@agigalaxy.org

${brandName}
https://agigalaxy.org/
${msg("galaxyMailPrivacy")}: https://agigalaxy.org/privacy/
</#macro>
