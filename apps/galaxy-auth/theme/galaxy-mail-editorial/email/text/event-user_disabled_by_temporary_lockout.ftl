<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>
${msg("eventUserDisabledByTemporaryLockoutBody", event.date)}
</@layout.emailLayout>

