<#ftl output_format="plainText">
<#macro emailLayout title="" category="" preheader="" brandName=(brand!"AGI Galaxy")>
${brandName}

${category?has_content?then(category, msg("galaxyMailDefaultCategory"))}

<#nested>

${msg("galaxyMailAutomatedNotice")}
${msg("galaxyMailContactTeam")}: team@agigalaxy.org

${msg("galaxyMailAbout")}: https://agigalaxy.org/how-it-works/
${msg("galaxyMailPrivacy")}: https://agigalaxy.org/privacy/
${msg("galaxyMailGuide")}: https://agigalaxy.org/docs/
© ${.now?string("yyyy")} ${brandName}
</#macro>
