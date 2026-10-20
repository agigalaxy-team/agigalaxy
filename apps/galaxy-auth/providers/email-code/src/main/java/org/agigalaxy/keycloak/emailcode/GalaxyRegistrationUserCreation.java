package org.agigalaxy.keycloak.emailcode;

import jakarta.ws.rs.core.MultivaluedHashMap;
import jakarta.ws.rs.core.MultivaluedMap;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.AuthenticationFlowException;
import org.keycloak.authentication.FormContext;
import org.keycloak.authentication.ValidationContext;
import org.keycloak.authentication.forms.RegistrationPage;
import org.keycloak.authentication.forms.RegistrationUserCreation;
import org.keycloak.events.Details;
import org.keycloak.events.Errors;
import org.keycloak.events.EventType;
import org.keycloak.models.UserModel;
import org.keycloak.protocol.oidc.OIDCLoginProtocol;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.services.messages.Messages;
import org.keycloak.userprofile.UserProfile;
import org.keycloak.userprofile.UserProfileContext;
import org.keycloak.userprofile.UserProfileProvider;

/** Explicit registration-flow action; normal new registrations stay native. */
public final class GalaxyRegistrationUserCreation extends RegistrationUserCreation {
    public static final String ID = "galaxy-registration-user-creation";
    private static final String CANDIDATE = "galaxy.registration.request-candidate";
    @Override public String getId() { return ID; }
    @Override public String getDisplayType() { return "Registration with unfinished email continuation"; }
    @Override public String getHelpText() {
        return "Creates new users natively; continues only credentialless local registrations after a fresh email proof.";
    }

    @Override public void validate(ValidationContext context) {
        var session = context.getSession();
        session.removeAttribute(CANDIDATE);
        if (RegistrationContinuation.enabled(context.getRealm())
            && "true".equals(context.getAuthenticationSession().getAuthNote(RegistrationContinuation.PASSWORD_AFTER_EMAIL_NOTE))) {
            String email = context.getHttpRequest().getDecodedFormParameters().getFirst(UserModel.EMAIL);
            if (email != null && !email.isBlank()) {
                UserModel candidate = session.users().getUserByEmail(context.getRealm(), email.trim());
                if (RegistrationContinuation.pending(session, context.getRealm(), candidate)) {
                    session.setAttribute(CANDIDATE, candidate.getId());
                    // Re-submitting registration can never supply a credential
                    // or update this user's existing profile through this form.
                    var data = context.getHttpRequest().getDecodedFormParameters();
                    data.remove(RegistrationPage.FIELD_PASSWORD);
                    data.remove(RegistrationPage.FIELD_PASSWORD_CONFIRM);
                }
            }
        }
        // Keeps native user-profile, custom-attribute, organization-invitation
        // and malformed-email validation. The existing user only scopes the
        // uniqueness validators; no profile update/create is called for it.
        super.validate(context);
    }

    @Override public UserProfile getOrCreateUserProfile(FormContext context, MultivaluedMap<String, String> formData) {
        UserModel candidate = candidate(context);
        if (candidate == null) return super.getOrCreateUserProfile(context, formData);
        var session = context.getSession();
        UserProfile profile = (UserProfile) session.getAttribute("UP_REGISTER");
        if (profile == null) {
            var attributes = new MultivaluedHashMap<>(formData);
            attributes.remove(RegistrationPage.FIELD_PASSWORD);
            attributes.remove(RegistrationPage.FIELD_PASSWORD_CONFIRM);
            attributes.remove(RegistrationPage.FIELD_RECAPTCHA_RESPONSE);
            profile = session.getProvider(UserProfileProvider.class).create(UserProfileContext.REGISTRATION, attributes, candidate);
            session.setAttribute("UP_REGISTER", profile);
        }
        return profile;
    }

    @Override public void success(FormContext context) {
        UserModel candidate = candidate(context);
        if (candidate == null) {
            super.success(context);
            if (RegistrationContinuation.enabled(context.getRealm())
                && "true".equals(context.getAuthenticationSession().getAuthNote(RegistrationContinuation.PASSWORD_AFTER_EMAIL_NOTE))) {
                RegistrationContinuation.begin(context.getAuthenticationSession(), context.getUser(), false);
            }
            return;
        }
        // Reuse the native guard against replacing another authenticated user.
        super.buildPage(context, null);
        var authentication = context.getAuthenticationSession();
        context.setUser(candidate);
        authentication.removeAuthNote(AuthenticationManager.NEW_USER_REGISTERED);
        RegistrationContinuation.begin(authentication, candidate, true);
        authentication.addRequiredAction(UserModel.RequiredAction.VERIFY_EMAIL);
        authentication.addRequiredAction(UserModel.RequiredAction.UPDATE_PASSWORD);
        authentication.setClientNote(OIDCLoginProtocol.LOGIN_HINT_PARAM, candidate.getUsername());
        context.newEvent().event(EventType.LOGIN).user(candidate).client(authentication.getClient())
            .detail(Details.REGISTER_METHOD, "form").detail("registration_resume", "true");
    }

    private UserModel candidate(FormContext context) {
        Object selected = context.getSession().getAttribute(CANDIDATE);
        if (!(selected instanceof String id)) return null;
        UserModel user = context.getSession().users().getUserById(context.getRealm(), id);
        String email = context.getHttpRequest().getDecodedFormParameters().getFirst(UserModel.EMAIL);
        if (!RegistrationContinuation.enabled(context.getRealm())
            || !"true".equals(context.getAuthenticationSession().getAuthNote(RegistrationContinuation.PASSWORD_AFTER_EMAIL_NOTE))
            || !RegistrationContinuation.pending(context.getSession(), context.getRealm(), user)
            || !RegistrationContinuation.normalizedEmail(email).equals(RegistrationContinuation.normalizedEmail(user.getEmail()))) {
            throw new AuthenticationFlowException(AuthenticationFlowError.GENERIC_AUTHENTICATION_ERROR,
                Errors.INVALID_REGISTRATION, Messages.EXPIRED_ACTION);
        }
        return user;
    }
}
