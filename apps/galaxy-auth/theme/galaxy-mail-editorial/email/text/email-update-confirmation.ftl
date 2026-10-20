<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>
${msg("emailUpdateConfirmationBody",link, newEmail, realmName, linkExpirationFormatter(linkExpiration))}
</@layout.emailLayout>

