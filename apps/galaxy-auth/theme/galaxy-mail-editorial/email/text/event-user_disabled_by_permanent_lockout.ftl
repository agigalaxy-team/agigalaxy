<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>
${msg("eventUserDisabledByPermanentLockoutBody", event.date)}
</@layout.emailLayout>

