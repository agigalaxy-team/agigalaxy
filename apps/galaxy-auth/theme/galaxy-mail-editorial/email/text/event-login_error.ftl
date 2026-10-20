<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>
${msg("eventLoginErrorBody",event.date,event.ipAddress)}
</@layout.emailLayout>

