<#ftl output_format="plainText">
<#import "template.ftl" as layout>
<@layout.emailLayout>

${msg("verifiableCredentialOfferBody",link, linkExpiration, realmName, credentialScopeDisplayName, linkExpirationFormatter(linkExpiration))}
</@layout.emailLayout>

