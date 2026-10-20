package org.agigalaxy.keycloak.emailcode;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.keycloak.models.SingleUseObjectProvider;

/** Standalone, no SMTP, no account / realm or external services. */
public final class EmailCodeChallengeStoreTest {
    public static void main(String[] args) throws Exception {
        singleUseAndBinding();
        resendAndExpiry();
        incorrectBudgetSurvivesResend();
        unknownAndDeliveryFailure();
        parallelConsumption();
        cancelAndRecipientCooldown();
        transactionAwareFirstSend();
        resendCodeCollision();
        System.out.println("Email-code challenge behavior: 8 cases passed");
    }

    private static void singleUseAndBinding() {
        Fixture fixture = new Fixture(EmailCodePolicy.DEFAULT);
        var binding = binding("tab-a", "member-a", true);
        String id = fixture.store.create(binding);
        AtomicReference<String> code = new AtomicReference<>();
        require(fixture.store.send(id, binding, code::set) == EmailCodeChallengeStore.SendResult.SENT, "send accepted");
        require(!fixture.cache.containsRawValue(code.get()), "cache must not contain the raw code");
        require(fixture.store.verify(id, binding("tab-b", "member-a", true), code.get()) == EmailCodeChallengeStore.VerifyResult.UNAVAILABLE, "different tab rejected");
        require(fixture.store.verify(id, binding("tab-a", "member-b", true), code.get()) == EmailCodeChallengeStore.VerifyResult.UNAVAILABLE, "different user rejected");
        require(fixture.store.verify(id, binding, code.get()) == EmailCodeChallengeStore.VerifyResult.VALID, "original transaction continues");
        require(fixture.store.verify(id, binding, code.get()) == EmailCodeChallengeStore.VerifyResult.UNAVAILABLE, "used code rejected");
        require(fixture.store.send(id, binding, ignored -> {}) == EmailCodeChallengeStore.SendResult.BLOCKED, "used transaction cannot resend");
    }

    private static void resendAndExpiry() {
        Fixture fixture = new Fixture(new EmailCodePolicy(10, 1, 5));
        var binding = binding("tab-a", "member-a", true);
        String id = fixture.store.create(binding);
        AtomicReference<String> first = new AtomicReference<>();
        AtomicReference<String> next = new AtomicReference<>();
        fixture.store.send(id, binding, first::set);
        require(fixture.store.send(id, binding, ignored -> {}) == EmailCodeChallengeStore.SendResult.WAIT, "cooldown enforced by server");
        require(fixture.store.view(id, binding).canResend(), "cooldown does not remove future resend capability");
        fixture.clock.advance(10);
        require(fixture.store.verify(id, binding, first.get()) == EmailCodeChallengeStore.VerifyResult.EXPIRED, "expiry enforced by server");
        fixture.store.send(id, binding, next::set);
        require(fixture.store.verify(id, binding, first.get()) == EmailCodeChallengeStore.VerifyResult.INVALID, "resend invalidates prior code");
        require(fixture.store.verify(id, binding, next.get()) == EmailCodeChallengeStore.VerifyResult.VALID, "new code valid");
    }

    private static void incorrectBudgetSurvivesResend() {
        Fixture fixture = new Fixture(EmailCodePolicy.DEFAULT);
        var binding = binding("tab-a", "member-a", true);
        String id = fixture.store.create(binding);
        AtomicReference<String> code = new AtomicReference<>();
        fixture.store.send(id, binding, code::set);
        for (int index = 0; index < 4; index++) {
            require(fixture.store.verify(id, binding, "invalid") == EmailCodeChallengeStore.VerifyResult.INVALID, "incorrect attempt counted");
        }
        fixture.clock.advance(60);
        fixture.store.send(id, binding, code::set);
        require(fixture.store.verify(id, binding, "invalid") == EmailCodeChallengeStore.VerifyResult.BLOCKED, "resend cannot reset attempt budget");
        require(fixture.store.verify(id, binding, code.get()) == EmailCodeChallengeStore.VerifyResult.BLOCKED, "attempt limit enforced");
        require(!fixture.store.view(id, binding).canResend(), "locked transaction cannot resend");
    }

    private static void unknownAndDeliveryFailure() {
        Fixture known = new Fixture(EmailCodePolicy.DEFAULT);
        Fixture unknown = new Fixture(EmailCodePolicy.DEFAULT);
        var knownBinding = binding("tab-a", "member-a", true);
        var unknownBinding = binding("tab-a", "", false);
        String first = known.store.create(knownBinding);
        String second = unknown.store.create(unknownBinding);
        AtomicReference<String> code = new AtomicReference<>();
        known.store.send(first, knownBinding, code::set);
        AtomicInteger delivered = new AtomicInteger();
        unknown.store.send(second, unknownBinding, ignored -> delivered.incrementAndGet());
        require(known.store.view(first, knownBinding).equals(unknown.store.view(second, unknownBinding)), "unknown recipient has the same public state");
        require(delivered.get() == 0, "unknown recipient is never emailed");
        require(unknown.store.verify(second, unknownBinding, code.get()) == EmailCodeChallengeStore.VerifyResult.INVALID, "unknown recipient can never verify");

        Fixture failed = new Fixture(EmailCodePolicy.DEFAULT);
        String failedId = failed.store.create(knownBinding);
        AtomicReference<String> notDelivered = new AtomicReference<>();
        var sent = failed.store.send(failedId, knownBinding, value -> { notDelivered.set(value); throw new Exception("synthetic mail unavailable"); });
        require(sent == EmailCodeChallengeStore.SendResult.SEND_FAILED, "mail failure reported internally");
        require(failed.store.view(failedId, knownBinding).equals(known.store.view(first, knownBinding)), "mail failure does not disclose recipient existence");
        require(failed.store.verify(failedId, knownBinding, notDelivered.get()) == EmailCodeChallengeStore.VerifyResult.INVALID, "failed delivery cannot authorize");
    }

    private static void parallelConsumption() throws Exception {
        Fixture fixture = new Fixture(EmailCodePolicy.DEFAULT);
        var binding = binding("tab-a", "member-a", true);
        String id = fixture.store.create(binding);
        AtomicReference<String> code = new AtomicReference<>();
        fixture.store.send(id, binding, code::set);
        CountDownLatch start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var left = executor.submit(() -> { start.await(); return fixture.store.verify(id, binding, code.get()); });
            var right = executor.submit(() -> { start.await(); return fixture.store.verify(id, binding, code.get()); });
            start.countDown();
            int success = (left.get() == EmailCodeChallengeStore.VerifyResult.VALID ? 1 : 0)
                + (right.get() == EmailCodeChallengeStore.VerifyResult.VALID ? 1 : 0);
            require(success == 1, "only one concurrent consumer succeeds");
        }
    }

    private static void cancelAndRecipientCooldown() {
        Fixture fixture = new Fixture(EmailCodePolicy.DEFAULT);
        var first = binding("tab-a", "member-a", true);
        var next = binding("tab-b", "member-a", true);
        String id = fixture.store.create(first);
        AtomicReference<String> code = new AtomicReference<>();
        fixture.store.send(id, first, code::set);
        String second = fixture.store.create(next);
        require(fixture.store.send(second, next, ignored -> {}) == EmailCodeChallengeStore.SendResult.WAIT, "new tabs do not bypass recipient cooldown");
        fixture.store.invalidate(id);
        require(fixture.store.verify(id, first, code.get()) == EmailCodeChallengeStore.VerifyResult.UNAVAILABLE, "cancelled challenge cannot authorize");
    }

    private static void transactionAwareFirstSend() {
        MutableClock clock = new MutableClock();
        DeferredCache cache = new DeferredCache(clock);
        // Prove that this fake models the actual 26.7.3 distinction, rather
        // than accidentally making deferred put() visible to atomic remove().
        cache.put("contract-probe", 60, Map.of("state", "pending"));
        require(cache.get("contract-probe") != null, "get reads the transaction's pending put");
        require(cache.remove("contract-probe") == null, "remove sees committed cache only");
        cache.rollback();

        // A reservation conflict is harmless: create retries a fresh UUID.
        cache.rejectChallengeReservations = 1;
        EmailCodeChallengeStore store = new EmailCodeChallengeStore(cache, EmailCodePolicy.DEFAULT, clock, new SequenceRandom());
        var binding = binding("tab-a", "member-a", true);
        String id = store.create(binding);
        require(cache.challengeReservations == 2, "initial reservation collision retried");
        AtomicReference<String> code = new AtomicReference<>();
        require(store.send(id, binding, code::set) == EmailCodeChallengeStore.SendResult.SENT, "first send in the create request succeeds before commit");
        require(store.view(id, binding).expiresIn() == 600, "first response can read its pending restored state");
        require(cache.pendingCount() == 1, "send restores through deferred put");
        require(store.verify(id, binding, code.get()) == EmailCodeChallengeStore.VerifyResult.UNAVAILABLE, "pending restore cannot be atomically consumed before commit");
        cache.flush();
        require(store.verify(id, binding, code.get()) == EmailCodeChallengeStore.VerifyResult.VALID, "committed first-send code verifies");
        require(store.verify(id, binding, code.get()) == EmailCodeChallengeStore.VerifyResult.UNAVAILABLE, "concurrent second consumer cannot read pending tombstone");
        cache.flush();
        require(store.verify(id, binding, code.get()) == EmailCodeChallengeStore.VerifyResult.UNAVAILABLE, "committed used tombstone cannot authorize again");
        cache.flush();
    }

    private static void resendCodeCollision() {
        MutableClock clock = new MutableClock();
        MemoryCache cache = new MemoryCache(clock);
        CollisionRandom random = new CollisionRandom(false);
        EmailCodeChallengeStore store = new EmailCodeChallengeStore(cache, EmailCodePolicy.DEFAULT, clock, random);
        var binding = binding("tab-a", "member-a", true);
        String id = store.create(binding);
        AtomicReference<String> first = new AtomicReference<>();
        AtomicReference<String> next = new AtomicReference<>();
        store.send(id, binding, first::set);
        clock.advance(60);
        require(store.send(id, binding, next::set) == EmailCodeChallengeStore.SendResult.SENT, "resend recovers from an RNG collision");
        require(!first.get().equals(next.get()) && random.draws.get() == 3, "identical candidate is redrawn before sending");
        require(store.verify(id, binding, first.get()) == EmailCodeChallengeStore.VerifyResult.INVALID, "old mail digits do not match new code");
        require(store.verify(id, binding, next.get()) == EmailCodeChallengeStore.VerifyResult.VALID, "replacement code remains valid");

        MutableClock failedClock = new MutableClock();
        CollisionRandom stuck = new CollisionRandom(true);
        EmailCodeChallengeStore failed = new EmailCodeChallengeStore(new MemoryCache(failedClock), EmailCodePolicy.DEFAULT, failedClock, stuck);
        String failedId = failed.create(binding);
        AtomicReference<String> original = new AtomicReference<>();
        failed.send(failedId, binding, original::set);
        failedClock.advance(60);
        AtomicInteger extraMail = new AtomicInteger();
        require(failed.send(failedId, binding, ignored -> extraMail.incrementAndGet()) == EmailCodeChallengeStore.SendResult.SEND_FAILED, "bounded repeated collision fails closed");
        require(stuck.draws.get() == 9 && extraMail.get() == 0, "collision retry is bounded and sends no duplicate code");
        require(failed.verify(failedId, binding, original.get()) == EmailCodeChallengeStore.VerifyResult.EXPIRED, "failed resend never restores the old code");
    }

    private static EmailCodeChallengeStore.Binding binding(String tab, String user, boolean eligible) {
        return new EmailCodeChallengeStore.Binding("realm", "browser-root", tab, "client", "reset-password", user,
            eligible ? "member@example.invalid" : "", "member@example.invalid", eligible);
    }
    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    private static final class Fixture {
        final MutableClock clock = new MutableClock();
        final MemoryCache cache = new MemoryCache(clock);
        final EmailCodeChallengeStore store;
        Fixture(EmailCodePolicy policy) { store = new EmailCodeChallengeStore(cache, policy, clock, new SequenceRandom()); }
    }
    private static final class SequenceRandom extends SecureRandom {
        private final AtomicInteger next = new AtomicInteger(271420);
        @Override public int nextInt(int bound) { return Math.floorMod(next.getAndIncrement(), bound); }
    }
    private static final class CollisionRandom extends SecureRandom {
        private final boolean stuck;
        final AtomicInteger draws = new AtomicInteger();
        CollisionRandom(boolean stuck) { this.stuck = stuck; }
        @Override public int nextInt(int bound) {
            int draw = draws.getAndIncrement();
            return Math.floorMod(stuck || draw < 2 ? 271420 : 271421, bound);
        }
    }
    private static final class MutableClock extends Clock {
        private final AtomicLong time = new AtomicLong(1_800_000_000);
        void advance(long seconds) { time.addAndGet(seconds); }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.ofEpochSecond(time.get()); }
    }
    private static final class MemoryCache implements SingleUseObjectProvider {
        private record Entry(long expires, Map<String, String> value) { }
        private final Map<String, Entry> entries = new HashMap<>();
        private final MutableClock clock;
        MemoryCache(MutableClock clock) { this.clock = clock; }
        @Override public synchronized void put(String key, long seconds, Map<String, String> notes) {
            entries.put(key, new Entry(clock.instant().getEpochSecond() + seconds, new HashMap<>(notes)));
        }
        @Override public synchronized Map<String, String> get(String key) {
            Entry entry = entries.get(key);
            if (entry == null) return null;
            if (entry.expires <= clock.instant().getEpochSecond()) { entries.remove(key); return null; }
            return new HashMap<>(entry.value);
        }
        @Override public synchronized Map<String, String> remove(String key) {
            Map<String, String> value = get(key);
            entries.remove(key);
            return value;
        }
        @Override public synchronized boolean replace(String key, Map<String, String> notes) {
            if (get(key) == null) return false;
            entries.put(key, new Entry(entries.get(key).expires, new HashMap<>(notes)));
            return true;
        }
        @Override public synchronized boolean putIfAbsent(String key, long seconds) {
            if (get(key) != null) return false;
            put(key, seconds, Map.of());
            return true;
        }
        @Override public synchronized boolean contains(String key) { return get(key) != null; }
        synchronized boolean containsRawValue(String value) {
            return entries.values().stream().anyMatch(entry -> entry.value.containsValue(value));
        }
        @Override public void close() { }
    }

    /** Keycloak 26.7.3 Infinispan contract: put is queued; get reads own queued
     * writes; remove / putIfAbsent / replace operate on committed entries now. */
    private static final class DeferredCache implements SingleUseObjectProvider {
        private record Entry(long expires, Map<String, String> value) { }
        private final Map<String, Entry> committed = new HashMap<>();
        private final Map<String, Entry> pending = new HashMap<>();
        private final MutableClock clock;
        int rejectChallengeReservations;
        int challengeReservations;
        DeferredCache(MutableClock clock) { this.clock = clock; }
        private Entry entry(Map<String, Entry> source, String key) {
            Entry entry = source.get(key);
            if (entry != null && entry.expires <= clock.instant().getEpochSecond()) {
                source.remove(key);
                return null;
            }
            return entry;
        }
        private Map<String, String> notes(Entry entry) {
            return entry == null || entry.value == null ? null : new HashMap<>(entry.value);
        }
        @Override public synchronized void put(String key, long seconds, Map<String, String> value) {
            pending.put(key, new Entry(clock.instant().getEpochSecond() + seconds, new HashMap<>(value)));
        }
        @Override public synchronized Map<String, String> get(String key) {
            return notes(pending.containsKey(key) ? entry(pending, key) : entry(committed, key));
        }
        @Override public synchronized Map<String, String> remove(String key) {
            Entry value = entry(committed, key);
            if (value != null) committed.remove(key);
            return notes(value);
        }
        @Override public synchronized boolean replace(String key, Map<String, String> value) {
            Entry before = entry(committed, key);
            if (before == null) return false;
            committed.put(key, new Entry(before.expires, new HashMap<>(value)));
            return true;
        }
        @Override public synchronized boolean putIfAbsent(String key, long seconds) {
            if (key.startsWith("galaxy-email-code:challenge:")) {
                challengeReservations++;
                if (rejectChallengeReservations > 0) { rejectChallengeReservations--; return false; }
            }
            if (entry(committed, key) != null) return false;
            committed.put(key, new Entry(clock.instant().getEpochSecond() + seconds, null));
            return true;
        }
        @Override public synchronized boolean contains(String key) { return entry(committed, key) != null; }
        synchronized int pendingCount() { return pending.size(); }
        synchronized void flush() { committed.putAll(pending); pending.clear(); }
        synchronized void rollback() { pending.clear(); }
        @Override public void close() { }
    }
}
