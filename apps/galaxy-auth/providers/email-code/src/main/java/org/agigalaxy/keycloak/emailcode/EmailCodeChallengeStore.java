package org.agigalaxy.keycloak.emailcode;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.Base64;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.keycloak.models.SingleUseObjectProvider;

/**
 * A challenge is owned by one AuthenticationSession, not by an email address.
 * Atomic remove is the Keycloak cluster-wide single-consumer operation. A failed
 * attempt restores only the updated budget; success leaves a used tombstone.
 */
final class EmailCodeChallengeStore {
    private static final String PREFIX = "galaxy-email-code:";
    private static final int TRANSACTION_SECONDS = 3600;
    private static final int MAX_RESERVATION_ATTEMPTS = 8;
    private static final int MAX_CODE_DRAWS = 8;
    private final SingleUseObjectProvider cache;
    private final Clock clock;
    private final SecureRandom random;
    private final EmailCodePolicy policy;

    enum SendResult { SENT, WAIT, BLOCKED, UNAVAILABLE, SEND_FAILED }
    enum VerifyResult { VALID, INVALID, EXPIRED, BLOCKED, UNAVAILABLE }
    record View(int expiresIn, int resendAfter, boolean blocked, boolean canResend) { }
    record Binding(String realm, String rootSession, String tab, String client,
                   String purpose, String userId, String email, String attemptedUsername,
                   boolean eligible) {
        String fingerprint() {
            return digest(String.join("\u0000", realm, rootSession, tab, client, purpose,
                userId, email, Boolean.toString(eligible)));
        }
        String cooldownKey() {
            String recipient = attemptedUsername.isBlank() ? email : attemptedUsername;
            return PREFIX + "cooldown:" + digest(realm + "\u0000" + purpose + "\u0000" + recipient.trim().toLowerCase(Locale.ROOT));
        }
    }
    @FunctionalInterface interface Delivery { void send(String code) throws Exception; }

    EmailCodeChallengeStore(SingleUseObjectProvider cache, EmailCodePolicy policy) {
        this(cache, policy, Clock.systemUTC(), new SecureRandom());
    }
    EmailCodeChallengeStore(SingleUseObjectProvider cache, EmailCodePolicy policy, Clock clock, SecureRandom random) {
        this.cache = cache;
        this.policy = policy;
        this.clock = clock;
        this.random = random;
    }

    String create(Binding binding) {
        Map<String, String> state = new HashMap<>();
        state.put("binding", binding.fingerprint());
        state.put("deadline", Long.toString(now() + TRANSACTION_SECONDS));
        state.put("attempts", "0");
        state.put("expires", "0");
        state.put("retry", "0");
        state.put("used", "false");
        state.put("digest", "");
        state.put("salt", "");
        state.put("delivered", "false");
        // In Keycloak 26.7.3 put() is deferred until transaction commit, while
        // remove() reads only committed cache entries. The first send happens
        // in this same request, so reserve + initialize through the immediate
        // atomic operations rather than queuing an invisible initial put().
        for (int attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt++) {
            String id = UUID.randomUUID().toString();
            if (cache.putIfAbsent(key(id), TRANSACTION_SECONDS) && cache.replace(key(id), state)) return id;
        }
        throw new IllegalStateException("email_code_challenge_unavailable");
    }

    View view(String id, Binding binding) {
        Map<String, String> state = cache.get(key(id));
        if (!matches(state, binding)) return new View(0, 0, false, false);
        boolean blocked = used(state) || number(state, "attempts") >= policy.maxAttempts();
        int remaining = seconds(number(state, "expires") - now());
        int retry = seconds(number(state, "retry") - now());
        // canResend is capability after the displayed cooldown, not a second
        // clock that would leave the browser button disabled indefinitely.
        return new View(remaining, retry, blocked, !blocked);
    }

    SendResult send(String id, Binding binding, Delivery delivery) {
        Map<String, String> removed = cache.remove(key(id));
        if (removed == null) return SendResult.UNAVAILABLE;
        Map<String, String> state = new HashMap<>(removed);
        try {
            if (!matches(state, binding)) return SendResult.UNAVAILABLE;
            if (used(state) || number(state, "attempts") >= policy.maxAttempts()) return SendResult.BLOCKED;
            if (number(state, "retry") > now()) return SendResult.WAIT;
            if (!cache.putIfAbsent(binding.cooldownKey(), policy.resendSeconds())) {
                state.put("retry", Long.toString(now() + policy.resendSeconds()));
                return SendResult.WAIT;
            }
            // Invalidate the preceding code before attempting delivery. Neither a
            // refresh nor a mail failure makes the preceding code valid again.
            String previousDigest = state.getOrDefault("digest", "");
            String previousSalt = state.getOrDefault("salt", "");
            state.put("digest", "");
            state.put("salt", "");
            state.put("expires", "0");
            state.put("delivered", "false");
            state.put("retry", Long.toString(now() + policy.resendSeconds()));
            String code = null;
            for (int draw = 0; draw < MAX_CODE_DRAWS; draw++) {
                String candidate = String.format(Locale.ROOT, "%06d", random.nextInt(1_000_000));
                if (previousDigest.isEmpty() || !sameDigest(previousDigest,
                    digest(previousSalt + "\u0000" + binding.fingerprint() + "\u0000" + candidate))) {
                    code = candidate;
                    break;
                }
            }
            // A failed RNG cannot resend the same digits or loop indefinitely.
            // The preceding digest remains invalidated and no mail is sent.
            if (code == null) return SendResult.SEND_FAILED;
            byte[] saltBytes = new byte[32];
            random.nextBytes(saltBytes);
            String salt = Base64.getUrlEncoder().withoutPadding().encodeToString(saltBytes);
            state.put("salt", salt);
            state.put("digest", digest(salt + "\u0000" + binding.fingerprint() + "\u0000" + code));
            state.put("expires", Long.toString(now() + policy.ttlSeconds()));
            try {
                if (binding.eligible()) delivery.send(code);
            } catch (Exception ignored) {
                // SMTP exceptions can include addresses or provider details. The
                // caller receives a fixed code; no exception payload is logged.
                return SendResult.SEND_FAILED;
            }
            state.put("delivered", Boolean.toString(binding.eligible()));
            return SendResult.SENT;
        } finally {
            restore(id, state);
        }
    }

    VerifyResult verify(String id, Binding binding, String submitted) {
        Map<String, String> removed = cache.remove(key(id));
        if (removed == null) return VerifyResult.UNAVAILABLE;
        Map<String, String> state = new HashMap<>(removed);
        try {
            if (!matches(state, binding) || used(state)) return VerifyResult.UNAVAILABLE;
            if (number(state, "attempts") >= policy.maxAttempts()) return VerifyResult.BLOCKED;
            if (number(state, "expires") <= now() || state.get("digest").isEmpty()) return VerifyResult.EXPIRED;
            String code = submitted == null || submitted.length() > 64 ? "" : submitted.replaceAll("\\s", "");
            boolean equal = sameDigest(state.get("digest"),
                digest(state.get("salt") + "\u0000" + binding.fingerprint() + "\u0000" + code));
            if (binding.eligible() && "true".equals(state.get("delivered")) && code.matches("[0-9]{6}") && equal) {
                state.put("used", "true");
                state.put("digest", "");
                state.put("salt", "");
                return VerifyResult.VALID;
            }
            long attempts = number(state, "attempts") + 1;
            state.put("attempts", Long.toString(attempts));
            return attempts >= policy.maxAttempts() ? VerifyResult.BLOCKED : VerifyResult.INVALID;
        } finally {
            restore(id, state);
        }
    }

    void invalidate(String id) {
        if (id == null) return;
        Map<String, String> removed = cache.remove(key(id));
        if (removed != null) {
            Map<String, String> state = new HashMap<>(removed);
            state.put("used", "true");
            state.put("digest", "");
            state.put("salt", "");
            restore(id, state);
        }
    }

    private boolean matches(Map<String, String> state, Binding binding) {
        return state != null && binding.fingerprint().equals(state.get("binding")) && number(state, "deadline") > now();
    }
    private boolean used(Map<String, String> state) { return "true".equals(state.get("used")); }
    private void restore(String id, Map<String, String> state) {
        long lifetime = number(state, "deadline") - now();
        if (lifetime > 0) cache.put(key(id), lifetime, state);
    }
    private long now() { return clock.instant().getEpochSecond(); }
    private static int seconds(long seconds) { return (int) Math.max(0, Math.min(seconds, Integer.MAX_VALUE)); }
    private static String key(String id) { return PREFIX + "challenge:" + id; }
    private static boolean sameDigest(String left, String right) {
        return MessageDigest.isEqual(left.getBytes(StandardCharsets.US_ASCII), right.getBytes(StandardCharsets.US_ASCII));
    }
    private static long number(Map<String, String> state, String key) {
        try { return Long.parseLong(state.getOrDefault(key, "0")); }
        catch (NumberFormatException ignored) { return 0; }
    }
    private static String digest(String value) {
        try {
            return Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
