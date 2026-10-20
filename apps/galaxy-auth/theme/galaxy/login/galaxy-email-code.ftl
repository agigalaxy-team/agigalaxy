<#import "template.ftl" as layout>
<#global pageId = "galaxy-email-code">
<#assign registration = (galaxyCodePurpose!"register") == "register">
<#assign blocked = galaxyCodeBlocked!false>
<#assign canResend = galaxyCodeCanResend!false>
<#assign resendAfter = galaxyCodeResendAfter!0>
<#assign expiresIn = galaxyCodeExpiresIn!0>
<#assign codeError = messagesPerField.existsError("code")>
<@layout.registrationLayout displayInfo=false displayMessage=!codeError; section>
    <#if section == "header">
        <#if registration>${msg("galaxyCodeRegisterTitle")}<#else>${msg("galaxyCodeResetTitle")}</#if>
    <#elseif section == "form">
        <div class="auth-email-code">
            <#if registration && galaxyCodeEmail?has_content>
                <p id="galaxy-code-destination" class="auth-code-destination">${galaxyCodeEmail}</p>
            <#elseif !registration>
                <p class="auth-code-description">${msg("galaxyCodeResetHelp")}</p>
            </#if>
            <form id="galaxy-email-code-form" action="${url.loginAction}" method="post" data-email-code-form>
                <input type="hidden" name="action" value="verify">
                <div class="form-group">
                    <label for="galaxy-email-code">${msg("galaxyCodeLabel")}</label>
                    <input id="galaxy-email-code" name="code" type="text"
                           class="${properties.kcInputClass!} auth-code-input"
                           inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}"
                           minlength="6" maxlength="6" required dir="ltr" spellcheck="false"
                           autocapitalize="none" aria-invalid="${codeError?c}"
                           aria-describedby="galaxy-code-help<#if registration && galaxyCodeEmail?has_content> galaxy-code-destination</#if><#if codeError> input-error-code</#if>"
                           <#if blocked>disabled<#else>autofocus</#if>>
                    <#if codeError>
                        <span id="input-error-code" class="kc-feedback-text" role="alert">${kcSanitize(messagesPerField.get("code"))?no_esc}</span>
                    </#if>
                    <p id="galaxy-code-help" class="auth-code-help"><#if expiresIn gt 0 && !blocked>${msg("galaxyCodeValidFor", (expiresIn / 60)?ceiling)}<#else>${msg("galaxyCodeHelp")}</#if></p>
                </div>
                <button id="galaxy-code-verify" type="submit" class="pf-c-button pf-m-primary pf-m-block site-primary-control"<#if blocked> disabled</#if>>${msg("galaxyCodeContinue")}</button>
            </form>
            <form id="galaxy-email-code-options" class="auth-code-options" action="${url.loginAction}" method="post">
                <button type="submit" name="action" value="resend" class="auth-code-text-button"
                        data-email-code-resend data-resend-after="${resendAfter?c}" data-can-resend="${canResend?c}"
                        data-resend-label="${msg("galaxyCodeResend")}"
                        data-resend-format="${msg("galaxyCodeResendAfter", "__SECONDS__")}"
                        aria-label="${msg("galaxyCodeResend")}"<#if !canResend || resendAfter gt 0> disabled</#if>>${msg("galaxyCodeResend")}</button>
                <div class="auth-code-return">
                    <#if !registration><button type="submit" name="action" value="change-email" class="auth-code-text-button">${msg("galaxyCodeChangeEmail")}</button></#if>
                    <button type="submit" name="action" value="cancel" class="auth-code-text-button">${msg("galaxyCodeCancel")}</button>
                </div>
            </form>
        </div>
    </#if>
</@layout.registrationLayout>
