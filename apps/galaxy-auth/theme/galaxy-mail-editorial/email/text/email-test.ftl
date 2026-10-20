<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>
${msg("emailTestBody", realmName)}
</@layout.emailLayout>

