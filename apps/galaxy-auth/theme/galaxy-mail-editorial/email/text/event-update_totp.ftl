<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>
${msg("eventUpdateTotpBody",event.date, event.ipAddress)}
</@layout.emailLayout>

