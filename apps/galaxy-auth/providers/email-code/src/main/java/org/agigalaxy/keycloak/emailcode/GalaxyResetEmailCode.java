package org.agigalaxy.keycloak.emailcode;

import java.util.ArrayList;
import java.util.List;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.authenticators.browser.AbstractUsernameFormAuthenticator;
import org.keycloak.authentication.authenticators.resetcred.ResetCredentialEmail;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserModel;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.storage.StorageId;

/** Email-code execution inside a copied reset-credentials flow. */
public final class GalaxyResetEmailCode extends ResetCredentialEmail {
    public static final String ID = "galaxy-reset-email-code";
    @Override public String getId() { return ID; }
    @Override public String getDisplayType() { return "Email Code for Password Reset"; }
    @Override public String getHelpText() { return "Verify a transaction-bound email code, then continue the original password reset flow."; }
    @Override public Authenticator create(KeycloakSession session) { return this; }
    @Override public List<ProviderConfigProperty> getConfigProperties() {
        List<ProviderConfigProperty> properties = new ArrayList<>(super.getConfigProperties());
        properties.addAll(EmailCodePolicy.properties());
        return properties;
    }

    @Override public void authenticate(AuthenticationFlowContext context) {
        EmailCodeSupport code = support(context);
        if (code.created) code.send();
        // Unknown / disabled / email-less users, including SMTP failures, retain
        // precisely the same page and actions. No user is created here.
        context.challenge(code.page(context.form(), null));
    }

    @Override public void action(AuthenticationFlowContext context) {
        EmailCodeSupport code = support(context);
        var data = context.getHttpRequest().getDecodedFormParameters();
        String action = data.getFirst("action");
        if ("cancel".equals(action)) {
            code.invalidate();
            context.cancelLogin();
            return;
        }
        if ("change-email".equals(action)) {
            code.invalidate();
            context.clearUser();
            context.getAuthenticationSession().removeAuthNote(AbstractUsernameFormAuthenticator.ATTEMPTED_USERNAME);
            context.resetFlow(() -> context.getAuthenticationSession()
                .setAuthNote(GalaxyResetChooseUser.FORCE_CHOICE_NOTE, "true"));
            return;
        }
        if ("resend".equals(action)) {
            EmailCodeChallengeStore.SendResult result = code.send();
            // Delivery success/failure is not an account-existence signal.
            String error = result == EmailCodeChallengeStore.SendResult.SEND_FAILED ? null : EmailCodeSupport.error(result);
            context.challenge(code.page(context.form(), error));
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
        UserModel user = context.getUser();
        // Eligibility, exact user and current email are part of the consumed
        // binding. Null-user dummy challenges can never reach this branch.
        user.setEmailVerified(true);
        user.removeRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
        context.getAuthenticationSession().removeRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
        if (forceLogin(context, user)) {
            context.getAuthenticationSession().setAuthNote(AuthenticationManager.END_AFTER_REQUIRED_ACTIONS, "true");
        }
        context.success();
    }

    private EmailCodeSupport support(AuthenticationFlowContext context) {
        return new EmailCodeSupport(context.getSession(), context.getRealm(), context.getAuthenticationSession(),
            context.getUser(), EmailCodeSupport.RESET,
            EmailCodePolicy.from(context.getAuthenticatorConfig() == null ? null : context.getAuthenticatorConfig().getConfig()),
            context.getAuthenticationSession().getAuthNote(AbstractUsernameFormAuthenticator.ATTEMPTED_USERNAME));
    }

    private boolean forceLogin(AuthenticationFlowContext context, UserModel user) {
        String force = context.getAuthenticatorConfig() == null ? null : context.getAuthenticatorConfig().getConfig().get(FORCE_LOGIN);
        if (force == null || FEDERATED_OPTION.equalsIgnoreCase(force)) {
            return !StorageId.isLocalStorage(user.getId()) || user.isFederated();
        }
        if ("true".equalsIgnoreCase(force)) return true;
        if ("false".equalsIgnoreCase(force)) return false;
        throw new IllegalArgumentException("Invalid force-login setting");
    }
}
