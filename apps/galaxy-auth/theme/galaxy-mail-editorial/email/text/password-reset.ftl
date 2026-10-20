<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>
${msg("passwordResetBody",link, linkExpiration, realmName, linkExpirationFormatter(linkExpiration))}
</@layout.emailLayout>

