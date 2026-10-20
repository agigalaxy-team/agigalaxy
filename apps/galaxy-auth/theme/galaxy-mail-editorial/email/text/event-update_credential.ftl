<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>
${msg("eventUpdateCredentialBody", event.getDetail("credential_type")!"unknown", event.date, event.ipAddress)}
</@layout.emailLayout>

