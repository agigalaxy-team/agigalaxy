package org.agigalaxy.keycloak.emailcode;

import java.util.List;
import java.util.Map;
import org.keycloak.provider.ProviderConfigProperty;

/** Bounded settings belong to the current required action / reset execution. */
record EmailCodePolicy(int ttlSeconds, int resendSeconds, int maxAttempts) {
    static final EmailCodePolicy DEFAULT = new EmailCodePolicy(600, 60, 5);
    static final String TTL = "code-ttl-seconds";
    static final String RESEND = "resend-seconds";
    static final String ATTEMPTS = "max-attempts";

    static EmailCodePolicy from(Map<String, String> values) {
        Map<String, String> settings = values == null ? Map.of() : values;
        return new EmailCodePolicy(
            integer(settings, TTL, DEFAULT.ttlSeconds, 2, 900),
            integer(settings, RESEND, DEFAULT.resendSeconds, 1, 300),
            integer(settings, ATTEMPTS, DEFAULT.maxAttempts, 1, 10));
    }

    private static int integer(Map<String, String> settings, String key, int fallback, int min, int max) {
        String value = settings.get(key);
        if (value == null || value.isBlank()) return fallback;
        try {
            int parsed = Integer.parseInt(value);
            if (parsed >= min && parsed <= max) return parsed;
        } catch (NumberFormatException ignored) { }
        throw new IllegalArgumentException("Invalid email-code setting: " + key);
    }

    static List<ProviderConfigProperty> properties() {
        return List.of(
            property(TTL, "Code lifetime (seconds)", "Default 600; bounded to 2–900 seconds.", "600"),
            property(RESEND, "Resend interval (seconds)", "Default 60; bounded to 1–300 seconds.", "60"),
            property(ATTEMPTS, "Incorrect attempts per transaction", "Resending does not reset this budget. Default 5; bounded to 1–10.", "5"));
    }

    private static ProviderConfigProperty property(String key, String label, String help, String value) {
        ProviderConfigProperty result = new ProviderConfigProperty();
        result.setName(key);
        result.setLabel(label);
        result.setHelpText(help);
        result.setType(ProviderConfigProperty.STRING_TYPE);
        result.setDefaultValue(value);
        return result;
    }
}
