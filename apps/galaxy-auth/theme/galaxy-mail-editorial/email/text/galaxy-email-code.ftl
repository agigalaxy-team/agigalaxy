<#ftl output_format="plainText">
<#if purpose != "register" && purpose != "reset-password"><#stop "Unsupported account email purpose"></#if>
<#assign actionSuffix = (purpose == "register")?then("Register", "Reset")>
<#import "template.ftl" as layout>
<@layout.emailLayout title=msg("galaxyEmailCodeTitle" + actionSuffix) category=msg("galaxyEmailCodePurpose" + actionSuffix) preheader=msg("galaxyEmailCodePreheader" + actionSuffix, brand) brandName=brand>
${msg("galaxyEmailCodeTitle" + actionSuffix)}

${msg("galaxyEmailCodeIntroduction" + actionSuffix, brand)}

${msg("galaxyEmailCodeInstruction" + actionSuffix)}

${msg("galaxyEmailCodeTextCode", code)}

${msg("galaxyEmailCodeExpiry", expiresInMinutes?c)}

${msg("galaxyEmailCodeSafety" + actionSuffix)}
</@layout.emailLayout>
