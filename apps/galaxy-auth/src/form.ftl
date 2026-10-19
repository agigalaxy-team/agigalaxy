<header class="auth-form-heading"><p class="auth-eyebrow">${msg("galaxyAccount")}</p><h1 id="kc-page-title"><#nested "header"></h1>
<p class="auth-form-context"><#if pageId == 'register' && !(passwordRequired??)>${msg("galaxyRegisterContext")}<#elseif client?? && client.clientId?? && client.clientId == 'galaxy-official'>${msg("galaxyLinkContext")}<#else>${msg("galaxyContext")}</#if></p>
<#if auth?has_content && auth.showUsername() && !auth.showResetCredentials()><#nested "show-username"><div id="kc-username"><span id="kc-attempted-username">${auth.attemptedUsername}</span><a id="reset-login" href="${url.loginRestartFlowUrl}">${msg("restartLoginTooltip")}</a></div></#if>
<#if displayRequiredFields><p class="auth-required"><span aria-hidden="true">*</span> ${msg("requiredFields")}</p></#if></header>
<div id="kc-content"><div id="kc-content-wrapper">
<#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)><div class="alert-${message.type} ${properties.kcAlertClass!}" role="<#if message.type == 'error'>alert<#else>status</#if>"><span class="${properties.kcAlertTitleClass!}">${kcSanitize(message.summary)?no_esc}</span></div></#if>
<#nested "form">
<#if auth?has_content && auth.showTryAnotherWayLink()><form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post"><div class="${properties.kcFormGroupClass!}"><input type="hidden" name="tryAnotherWay" value="on"><button type="submit" id="try-another-way" class="pf-c-button">${msg("doTryAnotherWay")}</button></div></form></#if>
<#if switchOrganizationEnabled?? && switchOrganizationEnabled><form id="kc-switch-organization-form" action="${url.loginAction}" method="post"><div class="${properties.kcFormGroupClass!}"><input type="hidden" name="switchOrganization" value="true"><button id="switch-organization" type="submit" class="pf-c-button">${msg("doSwitchOrganization")}</button></div></form></#if>
<#nested "socialProviders">
<#if displayInfo><div id="kc-info" class="${properties.kcSignUpClass!}"><div id="kc-info-wrapper"><#nested "info"></div></div></#if>
</div></div>
<div class="auth-submit-status" id="auth-submit-status" role="status" hidden><img src="${url.resourcesPath}/img/galaxy-mark.svg" alt=""><span id="auth-submit-message" data-offline="${msg("galaxyOffline")}" data-pending="${msg("galaxyPending")}">${msg("galaxyPending")}</span></div>
<p class="auth-form-footer">${msg("galaxyFooterNote")}</p>
<@loginFooter.content/>
