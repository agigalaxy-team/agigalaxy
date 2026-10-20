<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>

<#if firstName?? && lastName??>
    ${kcSanitize(msg("orgInviteBodyPersonalized", link, linkExpiration, realmName, organization.name, linkExpirationFormatter(linkExpiration), firstName, lastName))}
<#else>
    ${kcSanitize(msg("orgInviteBody", link, linkExpiration, realmName, organization.name, linkExpirationFormatter(linkExpiration)))}
</#if>
</@layout.emailLayout>

