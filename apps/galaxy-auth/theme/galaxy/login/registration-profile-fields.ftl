<#-- Derived from Keycloak 26.7.3 base/login/user-profile-commons.ftl.
     Copyright Keycloak contributors. Apache-2.0; bundled license under licenses/.
     Modified for Galaxy: omit names only from registration. Other forms inherit
     the original dynamic profile macro and retain their profile permissions. -->
<#import "user-profile-commons.ftl" as fields>
<#macro userProfileFormFields>
    <#assign currentGroup="">
    <#list profile.attributes as attribute>
        <#if attribute.name != 'firstName' && attribute.name != 'lastName'>
            <#if attribute.name == 'locale' && realm.internationalizationEnabled && locale.currentLanguageTag?has_content>
                <input type="hidden" id="${attribute.name}" name="${attribute.name}" value="${locale.currentLanguageTag}"/>
            <#else>
                <#assign group = (attribute.group)!"">
                <#if group != currentGroup>
                    <#assign currentGroup=group>
                    <#if currentGroup != "">
                        <div class="${properties.kcFormGroupClass!}"<#list group.html5DataAnnotations as key, value> data-${key}="${value}"</#list>>
                            <#assign groupDisplayHeader=group.displayHeader!"">
                            <#if groupDisplayHeader != ""><#assign groupHeaderText=advancedMsg(groupDisplayHeader)!group><#else><#assign groupHeaderText=group.name!""></#if>
                            <div class="${properties.kcContentWrapperClass!}"><label id="header-${attribute.group.name}" class="${kcFormGroupHeader!}">${groupHeaderText}</label></div>
                            <#assign groupDisplayDescription=group.displayDescription!"">
                            <#if groupDisplayDescription != "">
                                <div class="${properties.kcLabelWrapperClass!}"><label id="description-${group.name}" class="${properties.kcLabelClass!}">${advancedMsg(groupDisplayDescription)!""}</label></div>
                            </#if>
                        </div>
                    </#if>
                </#if>
                <#nested "beforeField" attribute>
                <div class="${properties.kcFormGroupClass!}">
                    <div class="${properties.kcLabelWrapperClass!}">
                        <label for="${attribute.name}" class="${properties.kcLabelClass!}">${advancedMsg(attribute.displayName!'')}</label>
                        <#if attribute.required><span class="required">*</span></#if>
                    </div>
                    <div class="${properties.kcInputWrapperClass!}">
                        <#if attribute.annotations.inputHelperTextBefore??><div class="${properties.kcInputHelperTextBeforeClass!}" id="form-help-text-before-${attribute.name}" aria-live="polite">${kcSanitize(advancedMsg(attribute.annotations.inputHelperTextBefore))?no_esc}</div></#if>
                        <@fields.inputFieldByType attribute=attribute/>
                        <#if messagesPerField.existsError('${attribute.name}')>
                            <span id="input-error-${attribute.name}" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">${kcSanitize(messagesPerField.get('${attribute.name}'))?no_esc}</span>
                        </#if>
                        <#if attribute.annotations.inputHelperTextAfter??><div class="${properties.kcInputHelperTextAfterClass!}" id="form-help-text-after-${attribute.name}" aria-live="polite">${kcSanitize(advancedMsg(attribute.annotations.inputHelperTextAfter))?no_esc}</div></#if>
                    </div>
                </div>
                <#nested "afterField" attribute>
            </#if>
        </#if>
    </#list>
    <#list profile.html5DataAnnotations?keys as key><script type="module" src="${url.resourcesPath}/js/${key}.js"></script></#list>
</#macro>
