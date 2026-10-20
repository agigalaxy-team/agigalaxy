package org.agigalaxy.keycloak.emailcode;

import jakarta.ws.rs.core.MultivaluedHashMap;
import java.util.Set;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.RequiredActionContextResult;
import org.keycloak.http.HttpRequest;
import org.keycloak.services.managers.AuthenticationManager;

/** Uses the real required-action result, not a mock cancel implementation. */
public final class EmailCodeRequiredActionTest {
    public static void main(String[] args) {
        mandatoryRegistrationCancelAbortsAuthentication();
        System.out.println("Email-code required-action contract: 1 case passed");
    }

    private static void mandatoryRegistrationCancelAbortsAuthentication() {
        var fixture = new EmailCodeTemplateProviderTest.Fixture(EmailCodeSupport.REGISTER);
        fixture.notes.put(AuthenticationManager.NEW_USER_REGISTERED, "true");
        EmailCodeSupport code = new EmailCodeSupport(fixture.session, fixture.realm,
            fixture.authentication, fixture.user, EmailCodeSupport.REGISTER, EmailCodePolicy.DEFAULT, "");
        var form = new MultivaluedHashMap<String, String>();
        form.add("action", "cancel");
        HttpRequest request = EmailCodeTemplateProviderTest.proxy(HttpRequest.class, (instance, method, arguments) -> {
            if ("getDecodedFormParameters".equals(method.getName())) return form;
            throw new UnsupportedOperationException("Unexpected fixture HTTP API: " + method.getName());
        });
        GalaxyVerifyEmailCode provider = new GalaxyVerifyEmailCode();
        RequiredActionContextResult context = new RequiredActionContextResult(fixture.authentication,
            fixture.realm, null, fixture.session, request, fixture.user, provider);

        provider.processAction(context);

        // LoginActionsService routes FAILURE through the original protocol's
        // sendError; CANCELLED would instead ask for required actions again.
        require(context.getStatus() == RequiredActionContext.Status.FAILURE,
            "cancelling a mandatory action must abort authentication, not resume its required-action loop");
        require(context.getErrorMessage() == null && context.getChallenge() == null,
            "Keycloak owns the protocol return without a custom URI or challenge");
        require(fixture.notes.get("galaxy.email-code.register") == null,
            "cancel removes the current code transaction note");
        require(code.verify("invalid") == EmailCodeChallengeStore.VerifyResult.UNAVAILABLE,
            "the cancelled challenge can never authorize the registration");
        require(fixture.requiredActions.equals(Set.of("VERIFY_EMAIL", "UPDATE_PASSWORD")),
            "cancel does not complete or remove pending email/password actions");
        require(!fixture.user.isEmailVerified() && fixture.delivered.get() == 0,
            "cancel neither verifies the email nor sends another code");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
