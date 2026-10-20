<#ftl output_format="plainText">
<#if purpose != "register" && purpose != "reset-password"><#stop "Unsupported account email purpose"></#if>
<#assign actionSuffix = (purpose == "register")?then("Register", "Reset")>
${brand}

${msg("galaxyEmailCodeTitle" + actionSuffix)}

${msg("galaxyEmailCodeIntroduction" + actionSuffix, brand)}
${msg("galaxyEmailCodeInstruction" + actionSuffix)}

${msg("galaxyEmailCodeTextCode", code)}
${msg("galaxyEmailCodeExpiry", expiresInMinutes?c)}

${msg("galaxyEmailCodeContinuation" + actionSuffix)}

${msg("galaxyEmailCodeSafety")}

${brand}
agigalaxy.org

