# Management email verification — Keycloak 26.7.3

This separate `galaxy-management` RealmResourceProvider lets the internal Galaxy management service request an email change. The existing account ID remains unchanged. A request sends the native confirmation to the new address; the current address remains active until the native verification handler accepts the link. Registration, password reset, the shared email theme, and the built-in action-token handler are not replaced.

The implementation targets the installed Keycloak **26.7.3** APIs and Java **21**, without adding a runtime dependency or an identity database. Those native APIs are distributed under Apache-2.0; the Keycloak license is included under `src/main/resources/META-INF/LICENSE-KEYCLOAK.txt`.

## Fixed service contract

Both endpoints require a native bearer token for the confidential, enabled service-account client `galaxy-management-account-maintenance` in `galaxy-operations`, with current `realm-management/manage-users` membership and client scope. Normal user tokens and cookies are insufficient. The realm, client and paths are compiled constants, and the machine authorization runs before a POST body is read.

* `GET /realms/galaxy-operations/galaxy-management/email-change-capabilities`: no query. Returns `{version:1,available:boolean,mode:'native-update-email',verificationBeforeChange:true,metadataOnly:true}`.
* `POST /realms/galaxy-operations/galaxy-management/users/:sub/email-change`: strict JSON `{operationId:<canonical UUID>,newEmail:<address>}`, maximum 8192 bytes, no query. Neither a client ID, redirect URI nor external URL is accepted.
* Accepted submission returns HTTP 202 `{version:1,operationId,state:'submitted',code:null,expiresAt:<epoch seconds>,metadataOnly:true}`. SMTP or commit uncertainty returns the same shape with `state:'unknown'` and `code:'management_identity_submission_unknown'`. A response never includes an address, token, confirmation URL or exception text. `submitted` does not mean delivery or completed verification.

The companion Node factory is `packages/galaxy-official/src/management-email-changes.mjs`, export `createManagementEmailChanges({issuer,privateOrigin,writer,fetch?,now?})`. The issuer must be HTTPS and end in `/realms/galaxy-operations`; `privateOrigin` is an origin, permitting HTTP only for loopback. `writer` is the already loaded protected `{clientId,clientSecret}` object, or `null`. No credential file is read by this module. All URLs, including the client-credentials endpoint, are derived from these server parameters. The Host header uses the public issuer host. Redirects are disabled, responses are limited to 64 KiB and requests have finite timeouts.

Its `available()` performs the authenticated native capability GET and returns true only for the matching protocol. `request({issuer,externalSubject},newEmail,{operationId,authorize})` requires a fresh authorization callback immediately before the single native POST. It returns only `{state:'submitted'|'failed'|'unknown',code}`. Write requests are never automatically retried. Inject the returned object as `emailChanges` in the existing `createKeycloakManagementAccounts` constructor; absence remains unavailable.

## Native verification and replay boundaries

The resource calls `UpdateEmail.validateEmailUpdate`, creates a native `UpdateEmailActionToken` with the real old value (including null or blank), signs it through `session.tokens()`, and invokes `sendEmailUpdateConfirmation` with the existing `email-update-confirmation.ftl` template. The expiration comes from the realm's existing `getActionTokenGeneratedByUserLifespan('update-email')`; this provider introduces no new duration policy. Only `UserModel.EMAIL_PENDING` is set after successful email submission. It never sets the active email or `emailVerified`.

The native `/login-actions/action-token` chain retains signature, realm issuer, expiry, enabled user/client, authenticated-cookie user and single-use checks. `UpdateEmailActionTokenHandler` checks the token's old address against the current address, and the token's new address against `EMAIL_PENDING`. Only that handler applies the profile change and verification flag. A superseded pending address, changed old address, expired link or modified signature is rejected. No custom token, browser callback or verification protocol is introduced, and the token has no redirect URI.

The original Node command ledger remains the durable authority for operator, target, original intent and dispatch. A native `SingleUseObjectProvider.putIfAbsent` guards overlapping operation IDs and targets using the existing token lifetime. Target locks release after the native transaction ends. Each accepted target operation also records a metadata-only marker under `galaxy.management.email-change.<operationId>`: intent digest, submission state and expiration. It contains no address, token, URL or password. This prevents the same target operation from sending again after its link expires. Native markers are not a replacement for the Node owner/target ledger, nor a general command-history API. A different target must never be substituted under an original Node operation ID.

Markers require a realm user-profile policy that prevents ordinary users from editing them. `available` fails closed if unmanaged attributes are enabled for ordinary users or any explicitly managed marker attribute is user-editable. It does not change that policy. Markers remain in native user storage; no cleanup schedule or new retention policy is set here.

SMTP cannot participate atomically in the Keycloak/Node database commit. A process/commit failure after SMTP submission is ambiguous; it remains unknown, and the existing Node accepted command must not be dispatched again. This code does not claim exactly-once mail or inbox delivery.

## AI-agent integration and deployment guide

1. Discover the active management issuer, private directory origin and protected dedicated writer reference from the authorized configuration loader. Do not read a human password, website writer, browser session or unrelated SMTP secret. The adapter does not expand native roles or create a client.
2. Build the new jar from this directory against the actual 26.7.3 distribution and JDK21. Output must be a new candidate directory. Example: `node build.mjs --keycloak-dir <fixed-distribution> --jdk-dir <jdk21> --out <new-candidate> --with-tests true --run-tests true`. The test runner uses the distribution's main and boot jars and explicitly selects its standard non-FIPS crypto provider for the local classpath check.
3. Native **`update-email` feature support must be enabled in the effective Keycloak build** so `DeclarativeUserProfileProviderFactory` registers the `UPDATE_EMAIL` context. First inspect the actual feature state; this document does not claim that the running service has it disabled. In 26.7.3 the feature option is build-time: if an explicit change is needed, `kc.sh build --feature-update-email=enabled` preserves other feature selections, or add `update-email` to the existing `--features` set at build time. A runtime-only flag on `start --optimized` is insufficient. Merely finding the handler SPI is insufficient. Do not turn on realm `verifyEmail`. Keep existing realm `UPDATE_EMAIL` required actions disabled/defaultAction=false unless separately authorized: the native default action is added disabled, and direct token validation works without enabling the browser required action. Review the active required-action metadata before a separately authorized deployment; this provider never changes it.
4. Root/deployment owner installs only this new jar and performs the normal optimized provider build/restart when authorized. Preserve the existing registration/reset provider and all current theme resources. No deployment is performed by this module's build.
5. Inject the Node adapter and read the authenticated capability endpoint. It must stay false for missing feature, missing handler/profile/template/SMTP host, incompatible frontend issuer or writable receipt markers. A configured SMTP host is a readiness prerequisite, not proof of a successful connection or delivery.
6. Actual email delivery and click-through verification require a separately authorized test identity and mailbox. The local checks do not make that production claim. Preserve the old address and subject during any acceptance check; inspect a fresh native user result after verification, not only an original submission receipt.

Common pitfalls: enabling only the handler without the profile feature; enabling a global realm verification rule to solve this narrower need; using `PUT email + VERIFY_EMAIL`; deriving a link from the private loopback request origin; confusing the writer service account with the human whose account is being maintained; treating `submitted` as verified; resending an unknown original command; recording raw SMTP/token errors; expecting a changed email to change the stable principal ID.

## Fixed upstream references

* [UpdateEmail](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/requiredactions/UpdateEmail.java)
* [UpdateEmailActionTokenHandler](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/actiontoken/updateemail/UpdateEmailActionTokenHandler.java)
* [DeclarativeUserProfileProviderFactory](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/userprofile/DeclarativeUserProfileProviderFactory.java)
* [DefaultRequiredActions](https://github.com/keycloak/keycloak/blob/26.7.3/server-spi-private/src/main/java/org/keycloak/models/utils/DefaultRequiredActions.java)
* [LoginActionsService](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/services/resources/LoginActionsService.java)
* [LoginActionsServiceChecks](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/services/resources/LoginActionsServiceChecks.java)

These are API and behavior references. No upstream provider class is bundled or replaced by this jar.
