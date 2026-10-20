package org.agigalaxy.keycloak.emailcode;

import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.keycloak.models.AbstractKeycloakTransaction;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.SingleUseObjectProvider;
import org.keycloak.models.UserModel;
import org.keycloak.sessions.AuthenticationSessionModel;
import org.keycloak.storage.StorageId;

/** Internal registration state. No request field can grant an email proof. */
final class RegistrationContinuation {
    static final String USER_NOTE = "galaxy.registration.user";
    static final String EMAIL_NOTE = "galaxy.registration.email";
    static final String MODE_NOTE = "galaxy.registration.mode";
    static final String PROOF_NOTE = "galaxy.registration.email-proof";
    // The native RegistrationPassword action sets this server-side note when
    // it will defer credential creation until after email verification.
    static final String PASSWORD_AFTER_EMAIL_NOTE = "update_password_after_email_verification_note";
    private static final int COMPLETION_SECONDS = 3600;

    static boolean enabled(RealmModel realm) {
        var config = realm.getRequiredActionConfigByAlias(UserModel.RequiredAction.VERIFY_EMAIL.name());
        return "galaxy".equals(realm.getName()) && realm.isVerifyEmail()
            && realm.isRegistrationEmailAsUsername() && !realm.isDuplicateEmailsAllowed()
            && config != null && config.getConfig() != null
            && "true".equals(config.getConfig().get(GalaxyVerifyEmailCode.ENABLE_KEY));
    }

    static boolean pending(KeycloakSession session, RealmModel realm, UserModel user) {
        if (user == null || !user.isEnabled() || user.getEmail() == null || user.getEmail().isBlank()
            || !StorageId.isLocalStorage(user.getId()) || user.getFederationLink() != null
            || user.getServiceAccountClientLink() != null) return false;
        try (var actions = user.getRequiredActionsStream()) {
            if (actions.noneMatch(UserModel.RequiredAction.UPDATE_PASSWORD.name()::equals)) return false;
        }
        try (var credentials = user.credentialManager().getCredentials()) {
            if (credentials.findAny().isPresent()) return false;
        }
        try (var identities = session.users().getFederatedIdentitiesStream(realm, user)) {
            return identities.findAny().isEmpty();
        }
    }

    static boolean hasTransaction(AuthenticationSessionModel authentication) {
        return authentication.getAuthNote(USER_NOTE) != null;
    }

    static void begin(AuthenticationSessionModel authentication, UserModel user, boolean resumed) {
        clear(authentication);
        authentication.setAuthNote(USER_NOTE, user.getId());
        authentication.setAuthNote(EMAIL_NOTE, normalizedEmail(user.getEmail()));
        authentication.setAuthNote(MODE_NOTE, resumed ? "resume" : "new");
    }

    static boolean current(KeycloakSession session, RealmModel realm,
                           AuthenticationSessionModel authentication, UserModel user) {
        return user != null && user.getId().equals(authentication.getAuthNote(USER_NOTE))
            && normalizedEmail(user.getEmail()).equals(authentication.getAuthNote(EMAIL_NOTE))
            && pending(session, realm, user);
    }

    static boolean resumed(AuthenticationSessionModel authentication) {
        return "resume".equals(authentication.getAuthNote(MODE_NOTE));
    }

    static boolean proved(AuthenticationSessionModel authentication) {
        return "true".equals(authentication.getAuthNote(PROOF_NOTE));
    }

    static void prove(AuthenticationSessionModel authentication) {
        authentication.setAuthNote(PROOF_NOTE, "true");
    }

    static void clear(AuthenticationSessionModel authentication) {
        for (String note : new String[] { USER_NOTE, EMAIL_NOTE, MODE_NOTE, PROOF_NOTE }) authentication.removeAuthNote(note);
    }

    static String normalizedEmail(String email) {
        return email == null ? "" : email.trim().toLowerCase(Locale.ROOT);
    }

    /** Serializes the first password write across already-verified tabs. The
     * cache reserve/replace operations are immediate in Keycloak 26.7.3. */
    static CompletionClaim claim(KeycloakSession session, RealmModel realm, UserModel user) {
        SingleUseObjectProvider cache = session.singleUseObjects();
        String key = "galaxy-registration:complete:" + realm.getId() + ":" + user.getId();
        String owner = UUID.randomUUID().toString();
        if (!cache.putIfAbsent(key, COMPLETION_SECONDS)) return null;
        if (!cache.replace(key, java.util.Map.of("owner", owner))) return null;
        CompletionClaim claim = new CompletionClaim(cache, key, owner);
        try {
            session.getTransactionManager().enlistAfterCompletion(claim);
        } catch (RuntimeException error) {
            claim.release();
            throw error;
        }
        return claim;
    }

    static final class CompletionClaim extends AbstractKeycloakTransaction {
        private final SingleUseObjectProvider cache;
        private final String key;
        private final String owner;
        private final long reservedAt = System.nanoTime();
        private boolean successful;
        CompletionClaim(SingleUseObjectProvider cache, String key, String owner) {
            this.cache = cache;
            this.key = key;
            this.owner = owner;
        }
        void successful() { successful = true; }
        @Override protected void commitImpl() { if (!successful) release(); }
        @Override protected void rollbackImpl() { release(); }
        private void release() {
            // An expired reservation may already belong to another request.
            // Never remove a replacement owner, including near the TTL edge.
            if (System.nanoTime() - reservedAt >= TimeUnit.SECONDS.toNanos(COMPLETION_SECONDS - 5)) return;
            var current = cache.get(key);
            if (current != null && owner.equals(current.get("owner"))) cache.remove(key);
        }
    }
}
