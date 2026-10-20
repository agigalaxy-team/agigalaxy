package org.agigalaxy.keycloak.emailcode;

import java.util.HashMap;
import java.util.Map;
import jakarta.ws.rs.core.Response;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.sessions.AuthenticationSessionModel;

final class EmailCodeSupport {
    static final String REGISTER = "register";
    static final String RESET = "reset-password";
    private static final String NOTE_PREFIX = "galaxy.email-code.";
    final KeycloakSession session;
    final RealmModel realm;
    final AuthenticationSessionModel authentication;
    final UserModel user;
    final String purpose;
    final EmailCodePolicy policy;
    final EmailCodeChallengeStore store;
    final EmailCodeChallengeStore.Binding binding;
    final String id;
    final boolean created;

    EmailCodeSupport(KeycloakSession session, RealmModel realm, AuthenticationSessionModel authentication,
                     UserModel user, String purpose, EmailCodePolicy policy, String attemptedUsername) {
        this.session = session;
        this.realm = realm;
        this.authentication = authentication;
        this.user = user;
        this.purpose = purpose;
        this.policy = policy;
        this.store = new EmailCodeChallengeStore(session.singleUseObjects(), policy);
        String email = user == null || user.getEmail() == null ? "" : user.getEmail().trim();
        boolean eligible = user != null && user.isEnabled() && !email.isBlank();
        this.binding = new EmailCodeChallengeStore.Binding(realm.getId(), authentication.getParentSession().getId(),
            authentication.getTabId(), authentication.getClient().getId(), purpose,
            user == null ? "" : user.getId(), email, attemptedUsername == null ? "" : attemptedUsername, eligible);
        String existing = authentication.getAuthNote(note());
        this.created = existing == null;
        this.id = existing == null ? store.create(binding) : existing;
        if (created) authentication.setAuthNote(note(), id);
    }

    EmailCodeChallengeStore.SendResult send() {
        return store.send(id, binding, code -> session.getProvider(EmailTemplateProvider.class)
            .setRealm(realm).setUser(user).setAuthenticationSession(authentication)
            .send(REGISTER.equals(purpose) ? "galaxyEmailCodeSubjectRegister" : "galaxyEmailCodeSubjectReset",
                // The real Keycloak provider adds locale / msg / user in-place.
                "galaxy-email-code.ftl", new HashMap<>(Map.of(
                    "code", code,
                    "purpose", purpose,
                    "brand", "AGI Galaxy",
                    "expiresInSeconds", policy.ttlSeconds(),
                    "expiresInMinutes", (int) Math.ceil(policy.ttlSeconds() / 60.0)))));
    }

    EmailCodeChallengeStore.VerifyResult verify(String code) { return store.verify(id, binding, code); }
    void invalidate() {
        store.invalidate(id);
        // resetFlow's handling of other auth notes is not our contract. The next
        // chosen address must create a fresh challenge even within the same tab.
        authentication.removeAuthNote(note());
    }

    Response page(LoginFormsProvider form, String error) {
        EmailCodeChallengeStore.View view = store.view(id, binding);
        form.setAuthenticationSession(authentication)
            .setAttribute("galaxyCodePurpose", purpose)
            .setAttribute("galaxyCodeEmail", REGISTER.equals(purpose) ? mask(binding.email()) : "")
            .setAttribute("galaxyCodeResendAfter", view.resendAfter())
            .setAttribute("galaxyCodeExpiresIn", view.expiresIn())
            .setAttribute("galaxyCodeBlocked", view.blocked())
            .setAttribute("galaxyCodeCanResend", view.canResend())
            .setResponseHeader("Cache-Control", "no-store")
            .setResponseHeader("Referrer-Policy", "no-referrer");
        if (error != null) form.setError(error);
        return form.createForm("galaxy-email-code.ftl");
    }

    static String error(EmailCodeChallengeStore.VerifyResult result) {
        return switch (result) {
            case INVALID -> "galaxyCodeInvalid";
            case EXPIRED -> "galaxyCodeExpired";
            case BLOCKED -> "galaxyCodeTooMany";
            case UNAVAILABLE -> "galaxyCodeUnavailable";
            case VALID -> null;
        };
    }
    static String error(EmailCodeChallengeStore.SendResult result) {
        return switch (result) {
            case WAIT -> "galaxyCodeResendWait";
            case BLOCKED -> "galaxyCodeTooMany";
            case UNAVAILABLE -> "galaxyCodeUnavailable";
            case SEND_FAILED -> "galaxyCodeSendFailed";
            case SENT -> null;
        };
    }
    private String note() { return NOTE_PREFIX + purpose; }
    private static String mask(String email) {
        int at = email.lastIndexOf('@');
        if (at < 1) return "";
        return email.substring(0, 1) + "***" + email.substring(at);
    }
}
