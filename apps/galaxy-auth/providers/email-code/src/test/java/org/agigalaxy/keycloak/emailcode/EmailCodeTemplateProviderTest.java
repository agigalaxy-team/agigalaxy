package org.agigalaxy.keycloak.emailcode;

import jakarta.enterprise.context.ContextNotActiveException;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.email.freemarker.FreeMarkerEmailTemplateProvider;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakContext;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.RequiredActionConfigModel;
import org.keycloak.models.SingleUseObjectProvider;
import org.keycloak.models.UserModel;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.keycloak.sessions.RootAuthenticationSessionModel;
import org.keycloak.theme.Theme;
import org.keycloak.theme.freemarker.FreeMarkerProvider;

/** Runs Keycloak's real send / processTemplate contract, without SMTP or a server.
 * Template rendering and final delivery stay in RAM; no code or message is printed. */
public final class EmailCodeTemplateProviderTest {
    public static void main(String[] args) throws Exception {
        sendThroughRealProvider(EmailCodeSupport.REGISTER);
        sendThroughRealProvider(EmailCodeSupport.RESET);
        immutableAttributesAreRejectedByRealProvider();
        System.out.println("Email-code real template provider contract: 3 cases passed");
    }

    private static void sendThroughRealProvider(String purpose) {
        Fixture fixture = new Fixture(purpose);
        EmailCodeSupport support = new EmailCodeSupport(fixture.session, fixture.realm,
            fixture.authentication, fixture.user, purpose, EmailCodePolicy.DEFAULT, "synthetic-member");

        require(support.send() == EmailCodeChallengeStore.SendResult.SENT,
            "real provider must accept and enrich the caller's attributes");
        require(fixture.rendered.get() == 2, "plain text and HTML both pass through processTemplate");
        require(fixture.delivered.get() == 1, "the final delivery boundary is reached once");
        require(support.verify(fixture.code.get()) == EmailCodeChallengeStore.VerifyResult.VALID,
            "only a successfully rendered and delivered challenge can verify");
    }

    private static void immutableAttributesAreRejectedByRealProvider() throws Exception {
        Fixture fixture = new Fixture(EmailCodeSupport.REGISTER);
        try {
            fixture.provider.setRealm(fixture.realm).setUser(fixture.user)
                .setAuthenticationSession(fixture.authentication)
                .send("galaxyEmailCodeSubjectRegister", "galaxy-email-code.ftl", Map.of("purpose", EmailCodeSupport.REGISTER));
            throw new AssertionError("real provider must exercise its in-place attribute enrichment");
        } catch (EmailException expected) {
            require(expected.getCause() instanceof UnsupportedOperationException,
                "an immutable caller map fails inside the real provider before rendering");
        }
        require(fixture.rendered.get() == 0 && fixture.delivered.get() == 0,
            "immutable attributes cannot reach either renderer or mail delivery");
    }

    static final class Fixture {
        final AtomicInteger rendered = new AtomicInteger();
        final AtomicInteger delivered = new AtomicInteger();
        final AtomicReference<String> code = new AtomicReference<>();
        final RealmModel realm;
        final UserModel user;
        final AuthenticationSessionModel authentication;
        final KeycloakSession session;
        final FreeMarkerEmailTemplateProvider provider;
        final Map<String, String> notes = new HashMap<>();
        final Set<String> requiredActions = new HashSet<>(Set.of("VERIFY_EMAIL", "UPDATE_PASSWORD"));

        Fixture(String purpose) {
            RequiredActionConfigModel actionConfig = new RequiredActionConfigModel();
            actionConfig.setConfig(Map.of(GalaxyVerifyEmailCode.ENABLE_KEY, "true"));
            Properties messages = new Properties();
            messages.setProperty("galaxyEmailCodeSubjectRegister", "Registration verification");
            messages.setProperty("galaxyEmailCodeSubjectReset", "Password reset verification");
            Theme theme = proxy(Theme.class, (instance, method, args) -> switch (method.getName()) {
                case "getEnhancedMessages", "getMessages" -> messages;
                case "getProperties" -> new Properties();
                default -> throw unexpected(method.getName());
            });
            realm = proxy(RealmModel.class, (instance, method, args) -> switch (method.getName()) {
                case "getId", "getName" -> "galaxy";
                case "getDisplayName" -> "AGI Galaxy";
                case "getRequiredActionConfigByAlias" -> actionConfig;
                default -> throw unexpected(method.getName());
            });
            user = proxy(UserModel.class, (instance, method, args) -> switch (method.getName()) {
                case "getId", "getUsername" -> "synthetic-member";
                case "getEmail" -> "member@example.invalid";
                case "isEnabled" -> true;
                case "isEmailVerified" -> false;
                case "getAttributes" -> null;
                default -> throw unexpected(method.getName());
            });
            ClientModel client = proxy(ClientModel.class, (instance, method, args) -> switch (method.getName()) {
                case "getId" -> "synthetic-client";
                default -> throw unexpected(method.getName());
            });
            RootAuthenticationSessionModel root = proxy(RootAuthenticationSessionModel.class,
                (instance, method, args) -> switch (method.getName()) {
                    case "getId" -> "synthetic-root";
                    default -> throw unexpected(method.getName());
                });
            authentication = proxy(AuthenticationSessionModel.class, (instance, method, args) -> switch (method.getName()) {
                case "getParentSession" -> root;
                case "getClient" -> client;
                case "getTabId" -> "synthetic-tab";
                case "getAuthNote" -> notes.get(args[0]);
                case "setAuthNote" -> { notes.put((String) args[0], (String) args[1]); yield null; }
                case "removeAuthNote" -> { notes.remove(args[0]); yield null; }
                case "getRequiredActions" -> requiredActions;
                case "addRequiredAction" -> {
                    requiredActions.add(args[0] instanceof UserModel.RequiredAction action ? action.name() : (String) args[0]);
                    yield null;
                }
                default -> throw unexpected(method.getName());
            });
            KeycloakContext context = proxy(KeycloakContext.class, (instance, method, args) -> switch (method.getName()) {
                case "resolveLocale" -> Locale.ENGLISH;
                // The provider explicitly supports no request URI for scheduled mail.
                case "getUri" -> throw new ContextNotActiveException();
                default -> throw unexpected(method.getName());
            });
            FreeMarkerProvider renderer = proxy(FreeMarkerProvider.class, (instance, method, args) -> {
                if (!"processTemplate".equals(method.getName())) throw unexpected(method.getName());
                Map<?, ?> attributes = (Map<?, ?>) args[0];
                String template = (String) args[1];
                require(template.equals("text/galaxy-email-code.ftl") || template.equals("html/galaxy-email-code.ftl"),
                    "both actual email formats use the same template name");
                require(Locale.ENGLISH.equals(attributes.get("locale")) && Boolean.TRUE.equals(attributes.get("ltr")),
                    "Keycloak has enriched the mutable body map before rendering");
                require(attributes.get("msg") != null && attributes.get("user") != null
                    && attributes.get("properties") instanceof Properties && attributes.get("subject") != null,
                    "real processTemplate context reaches the renderer");
                require(purpose.equals(attributes.get("purpose")) && "AGI Galaxy".equals(attributes.get("brand"))
                    && Integer.valueOf(600).equals(attributes.get("expiresInSeconds"))
                    && Integer.valueOf(10).equals(attributes.get("expiresInMinutes")),
                    "the caller's original code attributes are preserved");
                Object value = attributes.get("code");
                require(value instanceof String && ((String) value).matches("[0-9]{6}"),
                    "a generated code is available to the renderer only in RAM");
                code.set((String) value);
                rendered.incrementAndGet();
                return "synthetic body";
            });
            SingleUseObjectProvider cache = new ImmediateCache();
            AtomicReference<EmailTemplateProvider> reference = new AtomicReference<>();
            session = proxy(KeycloakSession.class, (instance, method, args) -> switch (method.getName()) {
                case "singleUseObjects" -> cache;
                case "getContext" -> context;
                case "getProvider" -> {
                    if (args[0] == FreeMarkerProvider.class) yield renderer;
                    if (args[0] == EmailTemplateProvider.class) yield reference.get();
                    throw unexpected("getProvider");
                }
                default -> throw unexpected(method.getName());
            });
            provider = new FreeMarkerEmailTemplateProvider(session) {
                @Override protected Theme getTheme() { return theme; }
                @Override protected void send(String subject, String textBody, String htmlBody, String address) {
                    require("synthetic body".equals(textBody) && "synthetic body".equals(htmlBody),
                        "only rendered messages reach delivery");
                    delivered.incrementAndGet();
                }
            };
            reference.set(provider);
        }
    }

    // Only supplies state for this rendering test. Transaction/cache semantics
    // are covered independently by EmailCodeChallengeStoreTest.
    static final class ImmediateCache implements SingleUseObjectProvider {
        private final Map<String, Map<String, String>> entries = new HashMap<>();
        @Override public void put(String key, long seconds, Map<String, String> notes) {
            entries.put(key, new HashMap<>(notes));
        }
        @Override public Map<String, String> get(String key) {
            Map<String, String> notes = entries.get(key);
            return notes == null ? null : new HashMap<>(notes);
        }
        @Override public Map<String, String> remove(String key) { return entries.remove(key); }
        @Override public boolean replace(String key, Map<String, String> notes) {
            if (!entries.containsKey(key)) return false;
            entries.put(key, new HashMap<>(notes));
            return true;
        }
        @Override public boolean putIfAbsent(String key, long seconds) {
            return entries.putIfAbsent(key, new HashMap<>()) == null;
        }
        @Override public boolean contains(String key) { return entries.containsKey(key); }
        @Override public void close() { }
    }

    @SuppressWarnings("unchecked")
    static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type }, (instance, method, args) -> {
            if (method.getDeclaringClass() == Object.class) {
                return switch (method.getName()) {
                    case "toString" -> "Synthetic " + type.getSimpleName();
                    case "hashCode" -> System.identityHashCode(instance);
                    case "equals" -> instance == args[0];
                    default -> throw unexpected(method.getName());
                };
            }
            return handler.invoke(instance, method, args);
        });
    }

    private static UnsupportedOperationException unexpected(String name) {
        return new UnsupportedOperationException("Unexpected fixture API: " + name);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
