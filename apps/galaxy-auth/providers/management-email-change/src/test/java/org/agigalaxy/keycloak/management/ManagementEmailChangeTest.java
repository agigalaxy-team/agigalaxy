package org.agigalaxy.keycloak.management;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.ws.rs.core.MultivaluedHashMap;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.UriBuilder;
import jakarta.ws.rs.core.UriInfo;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.BiFunction;
import java.util.stream.Stream;
import org.keycloak.TokenVerifier;
import org.keycloak.authentication.actiontoken.ActionTokenContext;
import org.keycloak.authentication.actiontoken.ActionTokenHandler;
import org.keycloak.authentication.actiontoken.DefaultActionToken;
import org.keycloak.authentication.actiontoken.updateemail.UpdateEmailActionToken;
import org.keycloak.authentication.actiontoken.updateemail.UpdateEmailActionTokenHandler;
import org.keycloak.common.Profile;
import org.keycloak.common.VerificationException;
import org.keycloak.common.util.Time;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.events.EventBuilder;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.jose.jws.JWSBuilder;
import org.keycloak.models.AdminRoles;
import org.keycloak.models.KeycloakContext;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakTransaction;
import org.keycloak.models.KeycloakTransactionManager;
import org.keycloak.models.KeycloakUriInfo;
import org.keycloak.models.RealmModel;
import org.keycloak.models.RoleModel;
import org.keycloak.models.ClientModel;
import org.keycloak.models.SingleUseObjectProvider;
import org.keycloak.models.ThemeManager;
import org.keycloak.models.TokenManager;
import org.keycloak.models.UserModel;
import org.keycloak.models.UserProvider;
import org.keycloak.representations.AccessToken;
import org.keycloak.services.managers.AuthenticationManager.AuthResult;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.keycloak.theme.Theme;
import org.keycloak.urls.HostnameProvider;
import org.keycloak.userprofile.UserProfile;
import org.keycloak.userprofile.UserProfileProvider;
import org.keycloak.userprofile.UserProfileContext;
import org.keycloak.userprofile.DeclarativeUserProfileProviderFactory;
import org.keycloak.representations.userprofile.config.UPConfig;

/** Real 26.7.3 token/handler + explicit in-memory model, bearer and SMTP doubles. No server/mail is used. */
public final class ManagementEmailChangeTest {
    static final String SUBJECT = "ac703e20-e725-442f-9f29-73165767acaf";
    static final String ISSUER = "https://admin.example.test/realms/galaxy-operations";
    static final ObjectMapper JSON = new ObjectMapper();

    public static void main(String[] args) throws Exception {
        // Quarkus normally selects the non-FIPS provider. Plain classpath ServiceLoader also sees
        // the optional FIPS module without its optional library, so select the actual default explicitly.
        org.keycloak.common.crypto.CryptoIntegration.setProvider(new org.keycloak.crypto.def.DefaultCryptoProvider());
        check("26.7.3".equals(org.keycloak.common.Version.VERSION), "actual installed native version");
        configureUpdateEmail(false);
        MetadataFactory disabled = new MetadataFactory(); disabled.init(proxy(org.keycloak.Config.Scope.class, (m, a) -> null));
        check(!disabled.hasUpdateEmail(), "native default profile context absent when feature is disabled");
        check(data(new Fixture().resource().capabilities()).get("available").equals(false), "feature-off capability fails closed");
        configureUpdateEmail(true);
        MetadataFactory enabled = new MetadataFactory(); enabled.init(proxy(org.keycloak.Config.Scope.class, (m, a) -> null));
        check(enabled.hasUpdateEmail(), "actual native factory registers update-email context");
        Fixture f = new Fixture();
        check(data(f.resource().capabilities()).get("available").equals(true), "native capabilities");
        InputStream unreadable = new InputStream() { @Override public int read() { throw new AssertionError("body read before auth"); } };
        check(new ManagementEmailChangeResource(f.session, s -> null).request(SUBJECT, unreadable).getStatus() == 401, "anonymous denied before body");
        f.serviceAccountLink = null;
        check(f.resource().request(SUBJECT, unreadable).getStatus() == 403, "human token denied before body");
        f.serviceAccountLink = "writer-native-id";
        f.manageUsers = false;
        check(f.resource().request(SUBJECT, unreadable).getStatus() == 403, "current manage-users required");
        f.manageUsers = true;
        check(f.resource().request(SUBJECT, bytes("{\"operationId\":\"bad\",\"newEmail\":\"x@example.test\",\"redirectUri\":\"https://outside.test\"}")).getStatus() == 400, "strict body");
        f.nativeHandler = false;
        check(data(f.resource().capabilities()).get("available").equals(false), "absent native handler unavailable");
        f.nativeHandler = true;
        f.unsafeUserAttributes = true;
        check(data(f.resource().capabilities()).get("available").equals(false), "user-writable journal policy unavailable");
        f.unsafeUserAttributes = false;

        String op = UUID.randomUUID().toString();
        Response submitted = f.resource().request(SUBJECT, request(op, "new@example.test"));
        check(submitted.getStatus() == 202 && data(submitted).get("state").equals("submitted"), "submission only: " + submitted.getStatus() + " " + data(submitted)
                + " encoded=" + (f.signedToken != null) + " link=" + (f.link != null) + " mailCalls=" + f.emails);
        check(f.email.equals("old@example.test") && f.attributes.get(UserModel.EMAIL_PENDING).equals("new@example.test"), "old email retained before verification");
        check(f.emails == 1 && !JSON.writeValueAsString(data(submitted)).contains("@"), "metadata-only response");
        f.commit();
        check(data(f.resource().request(SUBJECT, request(op, "new@example.test"))).get("state").equals("submitted") && f.emails == 1, "same operation no resend");
        check(f.resource().request(SUBJECT, request(op, "different@example.test")).getStatus() == 409 && f.emails == 1, "same operation different intent denied");

        // This is the actual built-in token serialization followed by actual Keycloak signature/issuer/expiry checks.
        UpdateEmailActionToken decoded = TokenVerifier.create(f.signedToken, UpdateEmailActionToken.class)
                .publicKey(f.signer.getPublic()).withChecks(TokenVerifier.IS_ACTIVE,
                        new TokenVerifier.RealmUrlCheck(ISSUER), DefaultActionToken.ACTION_TOKEN_BASIC_CHECKS).verify().getToken();
        check(decoded.getOldEmail().equals("old@example.test") && decoded.getNewEmail().equals("new@example.test"), "native token claims");
        URI mailLink = URI.create(f.link);
        check(mailLink.getHost().equals("admin.example.test") && mailLink.getPath().endsWith("/login-actions/action-token")
                && !f.link.contains("redirect_uri"), "native fixed frontend link");
        UpdateEmailActionTokenHandler handler = new UpdateEmailActionTokenHandler();
        ActionTokenContext<UpdateEmailActionToken> context = f.tokenContext(handler);
        check(!handler.canUseTokenRepeatedly(decoded, context), "native single-use handler");
        TokenVerifier.createWithoutSignature(decoded).withChecks(handler.getVerifiers(context)).verify();
        f.attributes.put(UserModel.EMAIL_PENDING, "superseded@example.test");
        check(handler.handleToken(decoded, context).getStatus() == 400 && f.email.equals("old@example.test"), "superseded pending rejected");
        f.attributes.put(UserModel.EMAIL_PENDING, "new@example.test");
        f.email = "changed@example.test";
        rejectsVerification(() -> TokenVerifier.createWithoutSignature(decoded).withChecks(handler.getVerifiers(context)).verify(), "changed old email rejected");
        f.email = "old@example.test";
        TokenVerifier.createWithoutSignature(decoded).withChecks(handler.getVerifiers(context)).verify();
        check(handler.handleToken(decoded, context).getStatus() == 200 && f.email.equals("new@example.test")
                && f.verified && !f.attributes.containsKey(UserModel.EMAIL_PENDING), "only native verification updates email");
        rejectsVerification(() -> TokenVerifier.createWithoutSignature(decoded).withChecks(handler.getVerifiers(context)).verify(), "post-verification replay invalid");
        try {
            Time.setOffset(600);
            rejectsVerification(() -> TokenVerifier.create(f.signedToken, UpdateEmailActionToken.class)
                    .publicKey(f.signer.getPublic()).withChecks(TokenVerifier.IS_ACTIVE).verify(), "expired native token rejected");
            f.cache.clear();
            check(data(f.resource().request(SUBJECT, request(op, "new@example.test"))).get("state").equals("submitted") && f.emails == 1,
                    "durable native marker does not resend expired operation");
        } finally { Time.setOffset(0); }
        String[] parts = f.signedToken.split("\\.");
        String tampered = parts[0] + "." + parts[1] + "." + (parts[2].charAt(0) == 'A' ? 'B' : 'A') + parts[2].substring(1);
        rejectsVerification(() -> TokenVerifier.create(tampered, UpdateEmailActionToken.class).publicKey(f.signer.getPublic()).verify(), "modified signature rejected");

        Fixture uncertain = new Fixture(); uncertain.smtpFails = true;
        String unknownOp = UUID.randomUUID().toString();
        check(data(uncertain.resource().request(SUBJECT, request(unknownOp, "next@example.test"))).get("state").equals("unknown"), "SMTP uncertainty preserved");
        uncertain.commit();
        check(!uncertain.attributes.containsKey(UserModel.EMAIL_PENDING) && uncertain.email.equals("old@example.test"), "uncertain submission never changes active email");
        check(data(uncertain.resource().request(SUBJECT, request(unknownOp, "next@example.test"))).get("state").equals("unknown") && uncertain.emails == 1,
                "uncertain same operation never resubmits");
        for (String initial : new String[]{null, ""}) {
            Fixture firstBinding = new Fixture(); firstBinding.email = initial; firstBinding.verified = false;
            String firstOperation = UUID.randomUUID().toString();
            Response first = firstBinding.resource().request(SUBJECT, request(firstOperation, "new@example.test"));
            check(data(first).get("state").equals("submitted") && java.util.Objects.equals(firstBinding.email, initial), "empty old address remains unchanged before verification");
            firstBinding.commit();
            UpdateEmailActionToken bindingToken = TokenVerifier.create(firstBinding.signedToken, UpdateEmailActionToken.class)
                    .publicKey(firstBinding.signer.getPublic()).withChecks(TokenVerifier.IS_ACTIVE,
                            new TokenVerifier.RealmUrlCheck(ISSUER), DefaultActionToken.ACTION_TOKEN_BASIC_CHECKS).verify().getToken();
            ActionTokenContext<UpdateEmailActionToken> bindingContext = firstBinding.tokenContext(handler);
            TokenVerifier.createWithoutSignature(bindingToken).withChecks(handler.getVerifiers(bindingContext)).verify();
            check(handler.handleToken(bindingToken, bindingContext).getStatus() == 200 && firstBinding.email.equals("new@example.test")
                    && firstBinding.verified && firstBinding.target.getId().equals(SUBJECT), "native first binding preserves subject");
        }
        System.out.println("{\"check\":\"management-email-native\",\"state\":\"passed\",\"keycloak\":\"26.7.3\",\"realTokenAndHandler\":true,\"oldEmailCases\":[\"normal\",\"null\",\"blank\"],\"smtp\":\"explicit-double\"}");
    }

    interface Verify { void run() throws VerificationException; }
    static void configureUpdateEmail(boolean enabled) {
        Map<Profile.Feature, Boolean> features = new HashMap<>(Profile.defaults().getFeatures());
        features.put(Profile.Feature.UPDATE_EMAIL, enabled);
        Profile.init(Profile.ProfileName.DEFAULT, features);
    }
    static void rejectsVerification(Verify verify, String name) throws Exception {
        try { verify.run(); throw new AssertionError(name); } catch (VerificationException expected) { }
    }
    static void check(boolean valid, String message) { if (!valid) throw new AssertionError(message); }
    @SuppressWarnings("unchecked") static Map<String, Object> data(Response response) { return (Map<String, Object>) response.getEntity(); }
    static InputStream bytes(String text) { return new ByteArrayInputStream(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
    static InputStream request(String op, String email) throws Exception { return new ByteArrayInputStream(JSON.writeValueAsBytes(Map.of("operationId", op, "newEmail", email))); }
    @SuppressWarnings("unchecked") static <T> T proxy(Class<T> type, BiFunction<String, Object[], Object> body) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (p, method, args) -> {
            Object result = body.apply(method.getName(), args == null ? new Object[0] : args);
            if (result != null || !method.getReturnType().isPrimitive()) return result;
            if (method.getReturnType() == boolean.class) return false;
            if (method.getReturnType() == int.class) return 0;
            if (method.getReturnType() == long.class) return 0L;
            return null;
        });
    }

    static final class Fixture {
        String email = "old@example.test", serviceAccountLink = "writer-native-id", link, signedToken;
        boolean verified = true, manageUsers = true, nativeHandler = true, smtpFails, unsafeUserAttributes;
        int emails;
        final Map<String, String> attributes = new HashMap<>();
        final Map<String, Map<String, String>> cache = new HashMap<>();
        final List<KeycloakTransaction> callbacks = new ArrayList<>();
        final KeyPair signer;
        final RoleModel role = proxy(RoleModel.class, (m, a) -> switch (m) { case "getId" -> "manage-users-id"; case "getName" -> AdminRoles.MANAGE_USERS; default -> null; });
        final ClientModel writer = proxy(ClientModel.class, (m, a) -> switch (m) {
            case "getId" -> "writer-native-id"; case "getClientId" -> ManagementEmailChangeResource.WRITER;
            case "isEnabled", "isServiceAccountsEnabled", "hasScope" -> true; default -> null;
        });
        final ClientModel management = proxy(ClientModel.class, (m, a) -> switch (m) {
            case "getClientId" -> "realm-management"; case "getRole" -> role; default -> null;
        });
        final RealmModel realm = proxy(RealmModel.class, (m, a) -> switch (m) {
            case "getName" -> ManagementEmailChangeResource.REALM; case "getId" -> "native-realm-id";
            case "isEnabled" -> true; case "getActionTokenGeneratedByUserLifespan" -> 300;
            case "getClientByClientId" -> a[0].equals("realm-management") ? management : writer;
            case "getSmtpConfig" -> Map.of("host", "explicit-smtp-double");
            case "getEventsListenersStream", "getEnabledEventTypesStream" -> Stream.empty(); default -> null;
        });
        final UserModel target = proxy(UserModel.class, (m, a) -> switch (m) {
            case "getId" -> SUBJECT; case "getUsername" -> "synthetic-manager"; case "getEmail" -> email;
            case "setEmail" -> { email = (String) a[0]; yield null; }
            case "isEnabled" -> true; case "isEmailVerified" -> verified;
            case "setEmailVerified" -> { verified = (Boolean) a[0]; yield null; }
            case "getFirstAttribute" -> attributes.get((String) a[0]);
            case "setSingleAttribute" -> { attributes.put((String) a[0], (String) a[1]); yield null; }
            case "removeAttribute" -> { attributes.remove((String) a[0]); yield null; }
            case "getAttributes" -> attributes.entrySet().stream().collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, v -> List.of(v.getValue())));
            default -> null;
        });
        final UserModel machine = proxy(UserModel.class, (m, a) -> switch (m) {
            case "getId" -> "service-account-id"; case "getServiceAccountClientLink" -> serviceAccountLink;
            case "isEnabled" -> true; case "hasRole" -> manageUsers; default -> null;
        });
        final AccessToken access = new AccessToken().issuedFor(ManagementEmailChangeResource.WRITER).issuer(ISSUER).subject("service-account-id");
        KeycloakSession session;
        KeycloakUriInfo uri;

        Fixture() throws Exception {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048); signer = generator.generateKeyPair();
            Theme theme = proxy(Theme.class, (m, a) -> {
                if (m.equals("getTemplate")) try { return URI.create("file:/explicit-theme-double/" + a[0]).toURL(); } catch (Exception e) { throw new AssertionError(e); }
                return null;
            });
            EmailTemplateProvider mail = proxy(EmailTemplateProvider.class, (m, a) -> {
                if (m.startsWith("set")) return session.getProvider(EmailTemplateProvider.class);
                if (m.equals("sendEmailUpdateConfirmation")) {
                    emails++; link = (String) a[0];
                    if (smtpFails) throw new WrappedEmailException();
                    check(a[2].equals("new@example.test"), "only new target receives native confirmation");
                }
                return null;
            });
            UserProfileProvider profiles = proxy(UserProfileProvider.class, (m, a) -> {
                if (m.equals("getConfiguration")) {
                    UPConfig config = new UPConfig();
                    if (unsafeUserAttributes) config.setUnmanagedAttributePolicy(UPConfig.UnmanagedAttributePolicy.ENABLED);
                    return config;
                }
                if (!m.equals("create")) return null;
                @SuppressWarnings("unchecked") Map<String, ?> values = (Map<String, ?>) a[1];
                Object value = values.get(UserModel.EMAIL);
                String changedEmail = value instanceof List<?> list ? (String) list.getFirst() : (String) value;
                return proxy(UserProfile.class, (name, ignored) -> {
                    if (name.equals("update")) email = changedEmail;
                    if (name.equals("getAttributes")) return proxy(org.keycloak.userprofile.Attributes.class,
                            (attributeMethod, attributeArgs) -> attributeMethod.equals("getFirst") ? changedEmail
                                    : attributeMethod.equals("get") ? List.of(changedEmail) : null);
                    return null;
                });
            });
            LoginFormsProvider forms = proxy(LoginFormsProvider.class, (m, a) -> {
                if (m.startsWith("set")) return session.getProvider(LoginFormsProvider.class);
                if (m.equals("createInfoPage")) return Response.ok().build();
                if (m.equals("createErrorPage")) return Response.status((Response.Status) a[0]).build();
                return null;
            });
            SingleUseObjectProvider singleUse = proxy(SingleUseObjectProvider.class, (m, a) -> switch (m) {
                case "putIfAbsent" -> cache.putIfAbsent((String) a[0], Map.of()) == null;
                case "get", "remove" -> m.equals("get") ? cache.get((String) a[0]) : cache.remove((String) a[0]);
                default -> null;
            });
            KeycloakTransactionManager transactions = proxy(KeycloakTransactionManager.class, (m, a) -> {
                if (m.equals("enlistAfterCompletion")) { KeycloakTransaction t = (KeycloakTransaction) a[0]; t.begin(); callbacks.add(t); }
                return null;
            });
            KeycloakContext context = proxy(KeycloakContext.class, (m, a) -> switch (m) {
                case "getRealm" -> realm; case "getUri" -> uri; case "resolveLocale" -> java.util.Locale.ENGLISH; default -> null;
            });
            session = proxy(KeycloakSession.class, (m, a) -> switch (m) {
                case "getContext" -> context; case "getTransactionManager" -> transactions; case "singleUseObjects" -> singleUse;
                case "getKeycloakSessionFactory" -> proxy(org.keycloak.models.KeycloakSessionFactory.class,
                        (n, ignored) -> n.equals("getProviderFactoriesStream") ? Stream.empty() : null);
                case "theme" -> proxy(ThemeManager.class, (n, ignored) -> n.equals("getTheme") ? theme : null);
                case "users" -> proxy(UserProvider.class, (n, ignored) -> n.equals("getUserById") ? target : null);
                case "tokens" -> proxy(TokenManager.class, (n, args) -> {
                    if (!n.equals("encode")) return null;
                    try { signedToken = new JWSBuilder().type("JWT").jsonContent(args[0]).rsa256(signer.getPrivate()); return signedToken; }
                    catch (RuntimeException error) { throw new AssertionError("native local signing setup", error); }
                });
                case "getProvider" -> {
                    Class<?> type = (Class<?>) a[0];
                    if (type == HostnameProvider.class) yield new HostnameProvider() { };
                    if (type == EmailTemplateProvider.class) yield mail;
                    if (type == UserProfileProvider.class) yield profiles;
                    if (type == ActionTokenHandler.class) yield nativeHandler ? new UpdateEmailActionTokenHandler() : null;
                    if (type == LoginFormsProvider.class) yield forms;
                    if (type == org.keycloak.tracing.TracingProvider.class) yield new org.keycloak.tracing.NoopTracingProvider();
                    yield null;
                }
                default -> null;
            });
            UriInfo underlying = proxy(UriInfo.class, (m, a) -> switch (m) {
                case "getBaseUri" -> URI.create("https://admin.example.test/");
                case "getBaseUriBuilder" -> UriBuilder.fromUri("https://admin.example.test/");
                case "getQueryParameters" -> new MultivaluedHashMap<String, String>(); default -> null;
            });
            uri = new KeycloakUriInfo(session, org.keycloak.urls.UrlType.FRONTEND, underlying);
        }
        ManagementEmailChangeResource resource() { return new ManagementEmailChangeResource(session, s -> new AuthResult(machine, null, access, writer)); }
        void commit() { for (KeycloakTransaction t : callbacks) t.commit(); callbacks.clear(); }
        ActionTokenContext<UpdateEmailActionToken> tokenContext(UpdateEmailActionTokenHandler handler) {
            EventBuilder event = new EventBuilder(realm, session);
            ActionTokenContext<UpdateEmailActionToken> context = new ActionTokenContext<>(session, realm, uri, null, null, event, handler, null, null, null, null);
            AuthenticationSessionModel authentication = proxy(AuthenticationSessionModel.class, (m, a) -> switch (m) {
                case "getAuthenticatedUser" -> target; case "getClient" -> writer; default -> null;
            });
            context.setAuthenticationSession(authentication, true);
            return context;
        }
    }
    static final class MetadataFactory extends DeclarativeUserProfileProviderFactory {
        boolean hasUpdateEmail() { return getContextualMetadataRegistry().containsKey(UserProfileContext.UPDATE_EMAIL); }
    }
    static final class WrappedEmailException extends RuntimeException { WrappedEmailException() { super(new EmailException("synthetic SMTP outcome unknown")); } }
}
