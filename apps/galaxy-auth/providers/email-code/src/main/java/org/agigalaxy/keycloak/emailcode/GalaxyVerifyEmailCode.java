package org.agigalaxy.keycloak.emailcode;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import jakarta.ws.rs.core.Response;
import org.keycloak.Config;
import org.keycloak.authentication.AuthenticationProcessor;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.RequiredActionFactory;
import org.keycloak.authentication.requiredactions.VerifyEmail;
import org.keycloak.events.EventType;
import org.keycloak.models.Constants;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserModel;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.services.Urls;
import org.keycloak.services.managers.AuthenticationManager;

/** Replaces the VERIFY_EMAIL action, including unverified existing logins. */
public final class GalaxyVerifyEmailCode extends VerifyEmail {
    public static final String ENABLE_KEY = "email-code-enabled";
    private Set<String> enabledRealms = Set.of("galaxy");

    @Override public int order() { return 100; }
    @Override public String getDisplayText() { return "Verify Email (Galaxy email code)"; }
    @Override public void init(Config.Scope config) {
        super.init(config);
        enabledRealms = Arrays.stream(config.get("realms", "galaxy").split(","))
            .map(String::trim).filter(value -> !value.isEmpty()).collect(Collectors.toUnmodifiableSet());
    }
    @Override public org.keycloak.authentication.RequiredActionProvider create(KeycloakSession session) { return this; }
    @Override public List<ProviderConfigProperty> getConfigMetadata() {
        List<ProviderConfigProperty> properties = new ArrayList<>(RequiredActionFactory.getMaxAuthAgePropertyConfig());
        ProviderConfigProperty enabled = new ProviderConfigProperty();
        enabled.setName(ENABLE_KEY);
        enabled.setLabel("Enable email code");
        enabled.setHelpText("Enable only after the matching login/email themes and copied reset flow are installed. Otherwise the original Verify Email action remains active.");
        enabled.setType(ProviderConfigProperty.BOOLEAN_TYPE);
        enabled.setDefaultValue("false");
        properties.add(enabled);
        properties.addAll(EmailCodePolicy.properties());
        return properties;
    }

    @Override public void requiredActionChallenge(RequiredActionContext context) {
        if (!usesEmailCode(context)) {
            super.requiredActionChallenge(context);
            return;
        }
        if (completeOrRestart(context)) return;
        EmailCodeSupport code = support(context);
        String error = code.created ? EmailCodeSupport.error(code.send()) : null;
        context.challenge(code.page(context.form(), error));
    }

    @Override public void processAction(RequiredActionContext context) {
        if (!usesEmailCode(context)) {
            super.processAction(context);
            return;
        }
        if (completeOrRestart(context)) return;
        EmailCodeSupport code = support(context);
        var data = context.getHttpRequest().getDecodedFormParameters();
        String action = data.getFirst("action");
        if ("cancel".equals(action)) {
            code.invalidate();
            RegistrationContinuation.clear(context.getAuthenticationSession());
            // cancel() only cancels an application-initiated action (AIA).
            // A mandatory registration action would immediately be requested
            // again. Failure terminates this authentication through Keycloak's
            // original LoginProtocol, retaining its validated client / state.
            context.failure();
            return;
        }
        if ("resend".equals(action)) {
            context.challenge(code.page(context.form(), EmailCodeSupport.error(code.send())));
            return;
        }
        if (!"verify".equals(action)) {
            context.challenge(code.page(context.form(), "galaxyCodeInvalid"));
            return;
        }
        EmailCodeChallengeStore.VerifyResult result = code.verify(data.getFirst("code"));
        if (result != EmailCodeChallengeStore.VerifyResult.VALID) {
            context.challenge(code.page(context.form(), EmailCodeSupport.error(result)));
            return;
        }
        // Only a successfully consumed code for this user's current email can
        // advance the original action. The remaining registration / password
        // actions, client redirect, PKCE and state remain Keycloak's own.
        context.getUser().setEmailVerified(true);
        if (RegistrationContinuation.hasTransaction(context.getAuthenticationSession())) {
            RegistrationContinuation.prove(context.getAuthenticationSession());
        }
        context.getAuthenticationSession().removeAuthNote(Constants.VERIFY_EMAIL_KEY);
        context.getEvent().clone().event(EventType.VERIFY_EMAIL).user(context.getUser()).success();
        context.success();
    }

    private boolean usesEmailCode(RequiredActionContext context) {
        Map<String, String> config = context.getConfig() == null ? null : context.getConfig().getConfig();
        return enabledRealms.contains(context.getRealm().getName())
            && config != null && "true".equals(config.get(ENABLE_KEY));
    }

    private EmailCodeSupport support(RequiredActionContext context) {
        if ("true".equals(context.getAuthenticationSession().getAuthNote(AuthenticationManager.NEW_USER_REGISTERED))) {
            context.getAuthenticationSession().addRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
        }
        return new EmailCodeSupport(context.getSession(), context.getRealm(), context.getAuthenticationSession(),
            context.getUser(), EmailCodeSupport.REGISTER,
            EmailCodePolicy.from(context.getConfig() == null ? null : context.getConfig().getConfig()), "");
    }

    private boolean completeOrRestart(RequiredActionContext context) {
        UserModel user = context.getUser();
        if (user == null || user.getEmail() == null || user.getEmail().isBlank()) {
            context.failure("galaxyCodeUnavailable");
            return true;
        }
        var authentication = context.getAuthenticationSession();
        if (RegistrationContinuation.hasTransaction(authentication)) {
            if (!RegistrationContinuation.current(context.getSession(), context.getRealm(), authentication, user)) {
                context.failure("galaxyCodeUnavailable");
                return true;
            }
            if (RegistrationContinuation.proved(authentication) && user.isEmailVerified()) {
                context.success();
                return true;
            }
            // An old verified flag is not proof for a new registration tab.
            // A resumed, still credentialless user must consume this tab's code.
            if (RegistrationContinuation.resumed(authentication)) return false;
        }
        if (!user.isEmailVerified()) return false;
        if ("true".equals(context.getAuthenticationSession().getAuthNote(AuthenticationManager.NEW_USER_REGISTERED))) {
            // Preserve Keycloak 26.7's protection against completing a newly
            // registered account after another authentication session verified it.
            var auth = context.getAuthenticationSession();
            URI restart = Urls.realmLoginRestartPage(context.getUriInfo().getBaseUri(), context.getRealm().getName(),
                auth.getClient().getClientId(), auth.getTabId(), AuthenticationProcessor.getClientData(context.getSession(), auth), false);
            context.challenge(Response.status(Response.Status.FOUND).location(restart).build());
        } else {
            context.getAuthenticationSession().removeAuthNote(Constants.VERIFY_EMAIL_KEY);
            context.success();
        }
        return true;
    }
}
