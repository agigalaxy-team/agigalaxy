package org.agigalaxy.keycloak.emailcode;

import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.FlowStatus;
import org.keycloak.authentication.authenticators.resetcred.ResetCredentialChooseUser;
import org.keycloak.models.KeycloakSession;

/** The stock chooser, with one explicit address choice after "change email". */
public final class GalaxyResetChooseUser extends ResetCredentialChooseUser {
    public static final String ID = "galaxy-reset-choose-user";
    static final String FORCE_CHOICE_NOTE = "galaxy.email-code.reset.choose";

    @Override public String getId() { return ID; }
    @Override public String getDisplayType() { return "Choose Password Reset Email"; }
    @Override public String getHelpText() { return "Use Keycloak's normal user selection; honor an explicit request to enter another email even when an SSO cookie exists."; }
    @Override public Authenticator create(KeycloakSession session) { return this; }

    @Override public void authenticate(AuthenticationFlowContext context) {
        if ("true".equals(context.getAuthenticationSession().getAuthNote(FORCE_CHOICE_NOTE))) {
            // Keep this one choice pending across refresh and validation errors.
            // A page GET must not silently reselect the SSO account.
            context.challenge(context.form().createPasswordReset());
            return;
        }
        super.authenticate(context);
    }

    @Override public void action(AuthenticationFlowContext context) {
        // Account lookup, disabled/unknown handling and input errors stay in the
        // upstream implementation. A successful choice consumes only our note.
        super.action(context);
        if (context.getStatus() == FlowStatus.SUCCESS) {
            context.getAuthenticationSession().removeAuthNote(FORCE_CHOICE_NOTE);
        }
    }
}
