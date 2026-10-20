package org.agigalaxy.keycloak.emailcode;

import jakarta.ws.rs.core.MultivaluedHashMap;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import org.keycloak.authentication.FormContext;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.RequiredActionContextResult;
import org.keycloak.authentication.RequiredActionFactory;
import org.keycloak.authentication.ValidationContext;
import org.keycloak.authentication.forms.RegistrationPassword;
import org.keycloak.credential.CredentialModel;
import org.keycloak.events.EventBuilder;
import org.keycloak.events.EventType;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.http.HttpRequest;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakContext;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.KeycloakTransaction;
import org.keycloak.models.KeycloakTransactionManager;
import org.keycloak.models.RealmModel;
import org.keycloak.models.RequiredActionConfigModel;
import org.keycloak.models.SubjectCredentialManager;
import org.keycloak.models.UserModel;
import org.keycloak.models.UserProvider;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.keycloak.sessions.RootAuthenticationSessionModel;
import org.keycloak.userprofile.Attributes;
import org.keycloak.userprofile.UserProfile;
import org.keycloak.userprofile.UserProfileProvider;
import static org.agigalaxy.keycloak.emailcode.EmailCodeTemplateProviderTest.proxy;

/** Targeted state contracts. Native profile/credential persistence and OIDC
 * returns are exercised separately in the real local Keycloak fixture. */
public final class RegistrationContinuationTest {
    public static void main(String[] args) {
        org.keycloak.common.Profile.configure();
        resumeKeepsTheExistingUserAndProfile();
        pendingIsNotEveryExistingEmail();
        verifiedEmailDoesNotProveANewRegistrationTab();
        staleOrUnprovedPasswordPagesCannotWrite();
        completionClaimsFollowTransactionOutcome();
        System.out.println("Registration continuation contracts: 5 cases passed");
    }

    private static void resumeKeepsTheExistingUserAndProfile() {
        Fixture fixture = new Fixture();
        fixture.data.putSingle("firstName", "Submitted replacement");
        fixture.data.putSingle("password", "synthetic-only");
        fixture.data.putSingle("password-confirm", "synthetic-only");
        GalaxyRegistrationUserCreation action = new GalaxyRegistrationUserCreation();
        action.validate(fixture.formContext);
        require(fixture.validations.get() == 1 && fixture.profileUser == fixture.user,
            "native validation sees the exact pending user without creating a new one");
        action.success(fixture.formContext);
        new RegistrationPassword().success(fixture.formContext);
        require(fixture.authenticated == fixture.user && fixture.profileWrites.get() == 0,
            "continuation attaches the original user without creating/updating its profile");
        require(!fixture.data.containsKey("password") && !fixture.data.containsKey("password-confirm")
            && fixture.passwordWrites.get() == 0, "re-registration cannot submit a password before the email proof");
        require("Existing given name".equals(fixture.user.getFirstName()), "existing names are retained");
        require(RegistrationContinuation.resumed(fixture.authentication) && !RegistrationContinuation.proved(fixture.authentication),
            "the new tab owns a registration continuation, not an email proof");
        require(fixture.actions.contains("UPDATE_PASSWORD") && fixture.sessionActions.contains("VERIFY_EMAIL"),
            "native password setup remains behind this session's required email action");
    }

    private static void pendingIsNotEveryExistingEmail() {
        Fixture fixture = new Fixture();
        require(RegistrationContinuation.pending(fixture.session, fixture.realm, fixture.user), "unverified credentialless setup is pending");
        fixture.verified = true;
        require(RegistrationContinuation.pending(fixture.session, fixture.realm, fixture.user), "verified but passwordless setup can resume with new proof");
        fixture.hasCredential = true;
        require(!RegistrationContinuation.pending(fixture.session, fixture.realm, fixture.user), "an existing login credential is not an incomplete registration");
        fixture.hasCredential = false;
        fixture.enabled = false;
        require(!RegistrationContinuation.pending(fixture.session, fixture.realm, fixture.user), "disabled accounts cannot resume");
        fixture.enabled = true;
        fixture.externalIdentity = true;
        require(!RegistrationContinuation.pending(fixture.session, fixture.realm, fixture.user), "external account identities are not adopted");
        fixture.externalIdentity = false;
        fixture.actions.clear();
        require(!RegistrationContinuation.pending(fixture.session, fixture.realm, fixture.user), "credentialless accounts without pending password setup are not adopted");
    }

    private static void verifiedEmailDoesNotProveANewRegistrationTab() {
        Fixture fixture = new Fixture();
        fixture.verified = true;
        RegistrationContinuation.begin(fixture.authentication, fixture.user, true);
        fixture.data.putSingle("action", "verify");
        fixture.data.putSingle("code", "invalid");
        RequiredActionContextResult context = fixture.context(new GalaxyVerifyEmailCode());
        new GalaxyVerifyEmailCode().processAction(context);
        require(context.getStatus() == RequiredActionContext.Status.CHALLENGE
            && !RegistrationContinuation.proved(fixture.authentication), "a prior verified flag cannot skip this tab's code");
    }

    private static void staleOrUnprovedPasswordPagesCannotWrite() {
        Fixture fixture = new Fixture();
        fixture.verified = true;
        RegistrationContinuation.begin(fixture.authentication, fixture.user, true);
        var guard = new GalaxyRegistrationUpdatePassword();
        var context = fixture.context(guard);
        guard.processAction(context);
        require(context.getStatus() == RequiredActionContext.Status.FAILURE && fixture.passwordWrites.get() == 0,
            "a verified account flag without this tab's consumed code cannot set a password");
        RegistrationContinuation.prove(fixture.authentication);
        fixture.hasCredential = true;
        context = fixture.context(guard);
        guard.processAction(context);
        require(context.getStatus() == RequiredActionContext.Status.FAILURE && fixture.passwordWrites.get() == 0,
            "an old proved tab cannot overwrite a credential completed in another tab");
        fixture.hasCredential = false;
        fixture.notes.put(RegistrationContinuation.USER_NOTE, "other-user");
        context = fixture.context(guard);
        guard.processAction(context);
        require(context.getStatus() == RequiredActionContext.Status.FAILURE, "proof cannot move to a different account");
    }

    private static void completionClaimsFollowTransactionOutcome() {
        Fixture fixture = new Fixture();
        var first = RegistrationContinuation.claim(fixture.session, fixture.realm, fixture.user);
        require(first != null && RegistrationContinuation.claim(fixture.session, fixture.realm, fixture.user) == null,
            "only one first-password transaction holds the claim");
        first.commit(); // Native validation did not succeed.
        var next = RegistrationContinuation.claim(fixture.session, fixture.realm, fixture.user);
        require(next != null, "native validation errors release the claim after the transaction");
        next.successful();
        next.rollback();
        var committed = RegistrationContinuation.claim(fixture.session, fixture.realm, fixture.user);
        require(committed != null, "rollback permits a new legitimate continuation");
        committed.successful();
        committed.commit();
        require(RegistrationContinuation.claim(fixture.session, fixture.realm, fixture.user) == null,
            "successful completion prevents a simultaneous old tab from writing");
        Fixture replacement = new Fixture();
        var owner = RegistrationContinuation.claim(replacement.session, replacement.realm, replacement.user);
        replacement.cache.replace("galaxy-registration:complete:galaxy:pending-user", Map.of("owner", "replacement-owner"));
        owner.rollback();
        require(replacement.cache.contains("galaxy-registration:complete:galaxy:pending-user"),
            "cleanup cannot remove a different completion owner");
    }

    private static final class Fixture {
        boolean enabled = true;
        boolean verified;
        boolean hasCredential;
        boolean externalIdentity;
        UserModel authenticated;
        UserModel profileUser;
        final Set<String> actions = new HashSet<>(Set.of("VERIFY_EMAIL", "UPDATE_PASSWORD"));
        final Set<String> sessionActions = new HashSet<>();
        final Map<String, String> notes = new HashMap<>();
        final Map<String, Object> requestAttributes = new HashMap<>();
        final MultivaluedHashMap<String, String> data = new MultivaluedHashMap<>();
        final AtomicInteger validations = new AtomicInteger();
        final AtomicInteger profileWrites = new AtomicInteger();
        final AtomicInteger passwordWrites = new AtomicInteger();
        final EmailCodeTemplateProviderTest.ImmediateCache cache = new EmailCodeTemplateProviderTest.ImmediateCache();
        final RealmModel realm;
        final UserModel user;
        final KeycloakSession session;
        final AuthenticationSessionModel authentication;
        final HttpRequest request;
        final ValidationContext formContext;

        Fixture() {
            data.putSingle("email", "member@example.invalid");
            notes.put(RegistrationContinuation.PASSWORD_AFTER_EMAIL_NOTE, "true");
            RequiredActionConfigModel config = new RequiredActionConfigModel();
            config.setConfig(Map.of(GalaxyVerifyEmailCode.ENABLE_KEY, "true"));
            realm = proxy(RealmModel.class, (instance, method, args) -> switch (method.getName()) {
                case "getName", "getId" -> "galaxy";
                case "isVerifyEmail", "isRegistrationEmailAsUsername" -> true;
                case "isDuplicateEmailsAllowed", "isOrganizationsEnabled", "isEventsEnabled" -> false;
                case "getRequiredActionConfigByAlias" -> config;
                case "getEventsListenersStream" -> Stream.empty();
                default -> throw unexpected(method.getName());
            });
            SubjectCredentialManager credentials = proxy(SubjectCredentialManager.class, (instance, method, args) -> switch (method.getName()) {
                case "getCredentials", "getStoredCredentialsStream" -> hasCredential ? Stream.of(new CredentialModel()) : Stream.empty();
                case "updateCredential" -> { passwordWrites.incrementAndGet(); hasCredential = true; yield true; }
                default -> throw unexpected(method.getName());
            });
            user = proxy(UserModel.class, (instance, method, args) -> switch (method.getName()) {
                case "getId" -> "pending-user";
                case "getEmail", "getUsername" -> "member@example.invalid";
                case "getFirstName" -> "Existing given name";
                case "isEnabled" -> enabled;
                case "isEmailVerified" -> verified;
                case "getFederationLink", "getServiceAccountClientLink" -> null;
                case "getRequiredActionsStream" -> actions.stream();
                case "credentialManager" -> credentials;
                case "addRequiredAction" -> { actions.add(actionName(args[0])); yield null; }
                default -> throw unexpected(method.getName());
            });
            UserProvider users = proxy(UserProvider.class, (instance, method, args) -> switch (method.getName()) {
                case "getUserByEmail" -> RegistrationContinuation.normalizedEmail((String) args[1]).equals("member@example.invalid") ? user : null;
                case "getUserById" -> "pending-user".equals(args[1]) ? user : null;
                case "getFederatedIdentitiesStream" -> externalIdentity ? Stream.of(new Object()) : Stream.empty();
                default -> throw unexpected(method.getName());
            });
            var client = proxy(ClientModel.class, (instance, method, args) -> switch (method.getName()) {
                case "getId", "getClientId" -> "synthetic-client";
                default -> throw unexpected(method.getName());
            });
            var root = proxy(RootAuthenticationSessionModel.class, (instance, method, args) -> {
                if ("getId".equals(method.getName())) return "synthetic-root";
                throw unexpected(method.getName());
            });
            authentication = proxy(AuthenticationSessionModel.class, (instance, method, args) -> switch (method.getName()) {
                case "getParentSession" -> root;
                case "getClient" -> client;
                case "getTabId" -> "synthetic-tab";
                case "getAuthNote" -> notes.get(args[0]);
                case "setAuthNote" -> { notes.put((String) args[0], (String) args[1]); yield null; }
                case "removeAuthNote" -> { notes.remove(args[0]); yield null; }
                case "addRequiredAction" -> { sessionActions.add(actionName(args[0])); yield null; }
                case "setClientNote" -> null;
                default -> throw unexpected(method.getName());
            });
            request = proxy(HttpRequest.class, (instance, method, args) -> {
                if ("getDecodedFormParameters".equals(method.getName())) return data;
                throw unexpected(method.getName());
            });
            Attributes attributes = proxy(Attributes.class, (instance, method, args) -> {
                if ("getFirst".equals(method.getName())) return data.getFirst((String) args[0]);
                throw unexpected(method.getName());
            });
            UserProfile profile = proxy(UserProfile.class, (instance, method, args) -> switch (method.getName()) {
                case "getAttributes" -> attributes;
                case "validate" -> { validations.incrementAndGet(); yield null; }
                case "create", "update" -> { profileWrites.incrementAndGet(); throw new AssertionError("Existing user profile must not be written"); }
                default -> throw unexpected(method.getName());
            });
            UserProfileProvider profiles = proxy(UserProfileProvider.class, (instance, method, args) -> {
                if (!"create".equals(method.getName())) throw unexpected(method.getName());
                profileUser = args.length == 3 ? (UserModel) args[2] : null;
                return profile;
            });
            LoginFormsProvider form = proxy(LoginFormsProvider.class, (instance, method, args) -> {
                if (method.getName().startsWith("set")) return instance;
                if ("createForm".equals(method.getName())) return null;
                throw unexpected(method.getName());
            });
            KeycloakContext context = proxy(KeycloakContext.class, (instance, method, args) -> {
                if ("getRealm".equals(method.getName())) return realm;
                throw unexpected(method.getName());
            });
            KeycloakSessionFactory factories = proxy(KeycloakSessionFactory.class, (instance, method, args) -> {
                if ("getProviderFactoriesStream".equals(method.getName())) return Stream.empty();
                throw unexpected(method.getName());
            });
            var completion = new ArrayList<KeycloakTransaction>();
            KeycloakTransactionManager transactions = proxy(KeycloakTransactionManager.class, (instance, method, args) -> {
                if ("enlistAfterCompletion".equals(method.getName())) {
                    KeycloakTransaction transaction = (KeycloakTransaction) args[0];
                    transaction.begin(); completion.add(transaction); return null;
                }
                throw unexpected(method.getName());
            });
            session = proxy(KeycloakSession.class, (instance, method, args) -> switch (method.getName()) {
                case "users" -> users;
                case "singleUseObjects" -> cache;
                case "getContext" -> context;
                case "getKeycloakSessionFactory" -> factories;
                case "getTransactionManager" -> transactions;
                case "getAttribute" -> requestAttributes.get(args[0]);
                case "setAttribute" -> { requestAttributes.put((String) args[0], args[1]); yield null; }
                case "removeAttribute" -> requestAttributes.remove(args[0]);
                case "getProvider" -> {
                    if (args[0] == UserProfileProvider.class) yield profiles;
                    if (args[0] == LoginFormsProvider.class) yield form;
                    if (args[0] == org.keycloak.organization.OrganizationProvider.class) yield null;
                    throw unexpected("getProvider");
                }
                default -> throw unexpected(method.getName());
            });
            EventBuilder event = new EventBuilder(realm, session).event(EventType.REGISTER);
            formContext = proxy(ValidationContext.class, (instance, method, args) -> switch (method.getName()) {
                case "getSession" -> session;
                case "getRealm" -> realm;
                case "getAuthenticationSession" -> authentication;
                case "getHttpRequest" -> request;
                case "getUser" -> authenticated;
                case "setUser" -> { authenticated = (UserModel) args[0]; yield null; }
                case "getEvent" -> event;
                case "newEvent" -> new EventBuilder(realm, session);
                case "getAuthenticatorConfig" -> null;
                case "success" -> null;
                default -> throw unexpected(method.getName());
            });
        }

        RequiredActionContextResult context(RequiredActionFactory factory) {
            return new RequiredActionContextResult(authentication, realm, null, session, request, user, factory) {
                @Override public LoginFormsProvider form() {
                    return session.getProvider(LoginFormsProvider.class);
                }
            };
        }
    }

    private static String actionName(Object value) {
        return value instanceof UserModel.RequiredAction action ? action.name() : (String) value;
    }
    private static UnsupportedOperationException unexpected(String method) {
        return new UnsupportedOperationException("Unexpected fixture API: " + method);
    }
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
