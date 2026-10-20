package org.agigalaxy.keycloak.emailcode;

import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.RequiredActionProvider;
import org.keycloak.authentication.requiredactions.UpdatePassword;
import org.keycloak.models.KeycloakSession;

/** Leaves ordinary password changes/resets native; guards only our registration. */
public final class GalaxyRegistrationUpdatePassword extends UpdatePassword {
    @Override public int order() { return 100; }
    @Override public RequiredActionProvider create(KeycloakSession session) { return this; }

    @Override public void requiredActionChallenge(RequiredActionContext context) {
        if (guarded(context) && !ready(context)) {
            context.failure("galaxyCodeUnavailable");
            return;
        }
        super.requiredActionChallenge(context);
    }

    @Override public void processAction(RequiredActionContext context) {
        if (!guarded(context)) {
            super.processAction(context);
            return;
        }
        if (!ready(context)) {
            context.failure("galaxyCodeUnavailable");
            return;
        }
        var claim = RegistrationContinuation.claim(context.getSession(), context.getRealm(), context.getUser());
        if (claim == null || !ready(context)) {
            context.failure("galaxyCodeUnavailable");
            return;
        }
        // Native password validation, policy and storage remain authoritative.
        // Policy errors retain the proof and release the claim after commit;
        // rollback also releases it. A successful first write keeps a tombstone.
        super.processAction(context);
        if (context.getStatus() == RequiredActionContext.Status.SUCCESS) {
            claim.successful();
            RegistrationContinuation.clear(context.getAuthenticationSession());
        }
    }

    private boolean guarded(RequiredActionContext context) {
        return "galaxy".equals(context.getRealm().getName())
            && RegistrationContinuation.hasTransaction(context.getAuthenticationSession());
    }

    private boolean ready(RequiredActionContext context) {
        return RegistrationContinuation.current(context.getSession(), context.getRealm(),
                context.getAuthenticationSession(), context.getUser())
            && context.getUser().isEmailVerified()
            && RegistrationContinuation.proved(context.getAuthenticationSession());
    }
}
