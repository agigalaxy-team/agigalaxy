package org.agigalaxy.keycloak.management;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.Provider;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.Supplier;
import org.keycloak.authentication.actiontoken.ActionTokenHandler;
import org.keycloak.authentication.actiontoken.updateemail.UpdateEmailActionToken;
import org.keycloak.authentication.actiontoken.updateemail.UpdateEmailActionTokenHandler;
import org.keycloak.authentication.requiredactions.UpdateEmail;
import org.keycloak.common.util.Time;
import org.keycloak.common.Profile;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.models.AbstractKeycloakTransaction;
import org.keycloak.models.AdminRoles;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.RoleModel;
import org.keycloak.models.SingleUseObjectProvider;
import org.keycloak.models.UserModel;
import org.keycloak.services.Urls;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.AuthenticationManager.AuthResult;
import org.keycloak.services.resources.admin.AdminAuth;
import org.keycloak.services.resources.LoginActionsService;
import org.keycloak.theme.Theme;
import org.keycloak.urls.UrlType;
import org.keycloak.userprofile.UserProfileProvider;
import org.keycloak.representations.userprofile.config.UPConfig;

/** Fixed internal machine endpoint. The signed verification GET remains entirely native. */
@Provider
@Produces(MediaType.APPLICATION_JSON)
public final class ManagementEmailChangeResource {
    public static final String REALM = "galaxy-operations";
    public static final String WRITER = "galaxy-management-account-maintenance";
    static final String MARKER_PREFIX = "galaxy.management.email-change.";
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
    private final KeycloakSession session;
    private final Function<KeycloakSession, AuthResult> authenticate;

    public ManagementEmailChangeResource(KeycloakSession session) {
        this(session, s -> new AppAuthManager.BearerTokenAuthenticator(s).authenticate());
    }

    // Package-only seam for the local native-class check; production always uses the bearer verifier.
    ManagementEmailChangeResource(KeycloakSession session, Function<KeycloakSession, AuthResult> authenticate) {
        this.session = session;
        this.authenticate = authenticate;
    }

    @GET
    @Path("email-change-capabilities")
    public Response capabilities() {
        return guarded(() -> {
            AuthResult auth = authorize();
            noQuery();
            boolean available = ready(auth);
            return response(200, Map.of("version", 1, "available", available,
                    "mode", "native-update-email", "verificationBeforeChange", true,
                    "metadataOnly", true));
        });
    }

    @POST
    @Path("users/{subject}/email-change")
    @Consumes(MediaType.APPLICATION_JSON)
    public Response request(@PathParam("subject") String subject, InputStream body) {
        return guarded(() -> {
            AuthResult auth = authorize(); // Never read a private body before machine authorization.
            noQuery();
            if (!ready(auth)) throw reject(503, "management_email_verification_not_configured");
            if (subject == null || !subject.matches("[A-Za-z0-9._:@-]{1,255}")
                    || subject.equals(".") || subject.equals("..")) throw reject(400, "invalid_management_accounts_request");
            JsonNode input = input(body);
            String operationId = input.get("operationId").textValue();
            String newEmail = input.get("newEmail").textValue();
            UserModel user = session.users().getUserById(session.getContext().getRealm(), subject);
            if (user == null || !Objects.equals(user.getId(), subject)) throw reject(404, "management_identity_not_found");
            if (!user.isEnabled() || user.getServiceAccountClientLink() != null)
                throw reject(409, "management_identity_target_changed");
            return send(auth, user, operationId, newEmail);
        });
    }

    private Response send(AuthResult auth, UserModel user, String operationId, String newEmail) {
        RealmModel realm = session.getContext().getRealm();
        String digest = intent(user.getId(), newEmail);
        String markerName = MARKER_PREFIX + operationId;
        String marker = user.getFirstAttribute(markerName);
        if (marker != null) return replay(marker, operationId, digest);
        try { UpdateEmail.validateEmailUpdate(session, user, newEmail); }
        catch (RuntimeException error) { throw reject(400, "management_identity_write_failed"); }
        String oldEmail = user.getEmail();
        if (Objects.equals(oldEmail, newEmail)) throw reject(409, "management_identity_target_changed");
        int lifetime = realm.getActionTokenGeneratedByUserLifespan(UpdateEmailActionToken.TOKEN_TYPE);
        int expiresAt;
        try { expiresAt = Math.addExact(Time.currentTime(), lifetime); }
        catch (ArithmeticException error) { throw reject(503, "management_email_verification_not_configured"); }
        SingleUseObjectProvider singleUse = session.singleUseObjects();
        String prefix = "galaxy.management.email-change:" + realm.getId() + ":";
        // Native atomic cache handles overlap; the original Node command is the durable owner/target authority.
        if (!singleUse.putIfAbsent(prefix + "op:" + operationId, lifetime))
            return result(operationId, "unknown", "management_identity_submission_unknown", expiresAt);
        String targetLock = prefix + "target:" + user.getId();
        if (!singleUse.putIfAbsent(targetLock, lifetime))
            throw reject(409, "management_identity_target_changed");
        session.getTransactionManager().enlistAfterCompletion(new AbstractKeycloakTransaction() {
            @Override protected void commitImpl() { singleUse.remove(targetLock); }
            @Override protected void rollbackImpl() { singleUse.remove(targetLock); }
        });
        // A metadata-only native marker also refuses re-sending an old operation after its token expires.
        // No verification token, URL, address or password is stored in this marker.
        user.setSingleAttribute(markerName, digest + ":unknown:" + expiresAt);
        try {
            // Recheck the target before creating the signed native token; never mutate the current email here.
            if (!Objects.equals(oldEmail, user.getEmail()) || !user.isEnabled())
                throw reject(409, "management_identity_target_changed");
            var uri = session.getContext().getUri(UrlType.FRONTEND);
            UpdateEmailActionToken token = new UpdateEmailActionToken(user.getId(), expiresAt,
                    oldEmail, newEmail, WRITER);
            // The native admin email flow has no browser tab/auth session. Its builder accepts that
            // shape; actionTokenBuilder is for an existing browser session and rejects a null tab.
            String link = LoginActionsService.actionTokenProcessor(uri)
                    .queryParam("key", token.serialize(session, realm, uri)).build(REALM).toString();
            session.getProvider(EmailTemplateProvider.class).setAuthenticationSession(null)
                    .setRealm(realm).setUser(user)
                    .sendEmailUpdateConfirmation(link, java.util.concurrent.TimeUnit.SECONDS.toMinutes(lifetime), newEmail);
            // Same ordering as native UpdateEmail: a failed/uncertain SMTP submission never activates the address.
            user.setSingleAttribute(UserModel.EMAIL_PENDING, newEmail);
            user.setSingleAttribute(markerName, digest + ":submitted:" + expiresAt);
            return result(operationId, "submitted", null, expiresAt);
        } catch (Rejected error) { throw error; }
        catch (Exception error) {
            // DATA/commit ambiguity is deliberately not retried. No exception text is logged or returned.
            return result(operationId, "unknown", "management_identity_submission_unknown", expiresAt);
        }
    }

    private Response replay(String marker, String operationId, String digest) {
        String[] fields = marker.split(":", -1);
        if (fields.length != 3 || !Objects.equals(fields[0], digest)
                || !fields[1].matches("submitted|unknown") || !fields[2].matches("[0-9]{1,10}"))
            throw reject(409, "management_identity_target_changed");
        try { return result(operationId, fields[1], fields[1].equals("submitted") ? null
                : "management_identity_submission_unknown", Integer.parseInt(fields[2])); }
        catch (NumberFormatException error) { throw reject(409, "management_identity_target_changed"); }
    }

    private AuthResult authorize() {
        RealmModel realm = session.getContext().getRealm();
        if (realm == null || !REALM.equals(realm.getName()) || !realm.isEnabled())
            throw reject(404, "management_identity_not_found");
        AuthResult auth;
        try { auth = authenticate.apply(session); }
        catch (RuntimeException error) { throw reject(401, "management_identity_client_unavailable"); }
        if (auth == null) throw reject(401, "management_identity_client_unavailable");
        ClientModel client = auth.client();
        if (client == null || auth.token() == null || auth.user() == null
                || !client.isEnabled() || client.isPublicClient() || !client.isServiceAccountsEnabled()
                || !WRITER.equals(client.getClientId()) || !WRITER.equals(auth.token().getIssuedFor())
                || !auth.user().isEnabled()
                || !Objects.equals(client.getId(), auth.user().getServiceAccountClientLink()))
            throw reject(403, "management_identity_write_forbidden");
        ClientModel management = realm.getClientByClientId("realm-management");
        RoleModel manageUsers = management == null ? null : management.getRole(AdminRoles.MANAGE_USERS);
        if (manageUsers == null || !auth.user().hasRole(manageUsers)
                || !new AdminAuth(realm, auth.token(), auth.user(), client).hasAppRole(management, AdminRoles.MANAGE_USERS))
            throw reject(403, "management_identity_write_forbidden");
        return auth;
    }

    private boolean ready(AuthResult auth) {
        try {
            RealmModel realm = session.getContext().getRealm();
            URI base = session.getContext().getUri(UrlType.FRONTEND).getBaseUri();
            String issuer = Urls.realmIssuer(base, REALM);
            if (!Profile.isFeatureEnabled(Profile.Feature.UPDATE_EMAIL)
                    || !"https".equals(base.getScheme()) || base.getUserInfo() != null || base.getQuery() != null
                    || base.getFragment() != null || !Objects.equals(issuer, auth.token().getIssuer())) return false;
            Theme theme = session.theme().getTheme(Theme.Type.EMAIL);
            UserProfileProvider profiles = session.getProvider(UserProfileProvider.class);
            return session.getProvider(ActionTokenHandler.class, UpdateEmailActionToken.TOKEN_TYPE) instanceof UpdateEmailActionTokenHandler
                    && profiles != null && protectedMarkers(profiles.getConfiguration())
                    && session.getProvider(EmailTemplateProvider.class) != null
                    && session.singleUseObjects() != null
                    && realm.getActionTokenGeneratedByUserLifespan(UpdateEmailActionToken.TOKEN_TYPE) > 0
                    && realm.getSmtpConfig() != null && realm.getSmtpConfig().get("host") != null
                    && !realm.getSmtpConfig().get("host").isBlank()
                    && theme != null && theme.getTemplate("html/email-update-confirmation.ftl") != null
                    && theme.getTemplate("text/email-update-confirmation.ftl") != null;
        } catch (Exception error) { return false; }
    }

    private static boolean protectedMarkers(UPConfig config) {
        if (config == null || config.getUnmanagedAttributePolicy() == UPConfig.UnmanagedAttributePolicy.ENABLED) return false;
        // Receipt markers must stay server-owned even if the realm later changes its profile policy.
        return config.getAttributes() == null || config.getAttributes().stream().noneMatch(attribute ->
                attribute.getName() != null && attribute.getName().startsWith(MARKER_PREFIX)
                && attribute.getPermissions() != null && attribute.getPermissions().getEdit().contains("user"));
    }

    private void noQuery() {
        if (!session.getContext().getUri().getQueryParameters().isEmpty())
            throw reject(400, "invalid_management_accounts_request");
    }

    private static JsonNode input(InputStream body) {
        try {
            if (body == null) throw new IllegalArgumentException();
            byte[] bytes = body.readNBytes(8193);
            if (bytes.length > 8192) throw new IllegalArgumentException();
            JsonNode node = JSON.readTree(bytes);
            if (node == null || !node.isObject() || node.size() != 2 || !node.hasNonNull("operationId")
                    || !node.hasNonNull("newEmail") || !node.get("operationId").isTextual()
                    || !node.get("newEmail").isTextual()) throw new IllegalArgumentException();
            String op = node.get("operationId").textValue(), email = node.get("newEmail").textValue();
            if (!UUID.fromString(op).toString().equals(op) || email.isBlank() || email.length() > 320
                    || !email.equals(email.strip()) || email.chars().anyMatch(c -> c < 32 || c == 127))
                throw new IllegalArgumentException();
            return node;
        } catch (Exception error) { throw reject(400, "invalid_management_accounts_request"); }
    }

    private static String intent(String subject, String newEmail) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest((subject + "\0" + newEmail).getBytes(StandardCharsets.UTF_8))); }
        catch (Exception error) { throw reject(503, "management_identity_unavailable"); }
    }

    private static Response result(String op, String state, String code, int expiresAt) {
        var value = new java.util.LinkedHashMap<String, Object>();
        value.put("version", 1); value.put("operationId", op); value.put("state", state);
        value.put("code", code); value.put("expiresAt", expiresAt); value.put("metadataOnly", true);
        return response(202, value);
    }
    private static Response response(int status, Object value) {
        return Response.status(status).type(MediaType.APPLICATION_JSON_TYPE).header("Cache-Control", "no-store").entity(value).build();
    }
    private static Response guarded(Supplier<Response> action) {
        try { return action.get(); }
        catch (Rejected error) { return response(error.status, Map.of("code", error.code)); }
        catch (Exception error) { return response(503, Map.of("code", "management_identity_unavailable")); }
    }
    private static Rejected reject(int status, String code) { return new Rejected(status, code); }
    private static final class Rejected extends RuntimeException {
        final int status;
        final String code;
        Rejected(int status, String code) { super(code); this.status = status; this.code = code; }
    }
}
