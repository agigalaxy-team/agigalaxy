package workerconfig

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/jackc/pgx/v5"
	"strconv"
	"strings"
)

// VerifyLegacyPendingSourceWithin is maintenance-only technical source binding.
// It loads no account/admin cookies, key or Actor, and does not authorize or
// execute business effects. The normal consumer still checks all current grants,
// leases and original receipts after cutover. No runtime auto-calls adoption.
func VerifyLegacyPendingSourceWithin(ctx context.Context, tx pgx.Tx, endpoint string, legacy jobs.LegacyPendingJob, t jobs.Task) error {
	changed := func() error { return fault.New("operations_job_adoption_source_changed", 409) }
	if t.Endpoint != endpoint || t.ID != legacy.ID || t.Action != legacy.Queue {
		return changed()
	}
	check := func(sql string, args ...any) error {
		var found bool
		e := tx.QueryRow(ctx, sql, args...).Scan(&found)
		if errors.Is(e, pgx.ErrNoRows) {
			return changed()
		}
		return e
	}
	switch t.Action {
	case jobs.InformationWatch:
		return check(`SELECT true FROM information_watches_v2 w JOIN bindings b ON b.id=(w.background_authority->>'bindingId')::uuid AND b.subject_id=w.subject_id
    WHERE w.id=$1 AND w.subject_id=$2 AND w.revision=$3 AND w.check_revision=$4 AND w.state='active' AND w.expires_at>now() AND w.background_authority IS NOT NULL AND b.audience=$5 AND b.revoked_at IS NULL
    FOR SHARE OF w,b`, t.SourceID, legacy.Data["subjectId"], adoptionSourceInteger(legacy.Data["revision"]), adoptionSourceInteger(legacy.Data["checkRevision"]), endpoint)
	case jobs.SearchRecovery:
		return check(`SELECT true FROM jobs j JOIN search_index_control c ON c.singleton AND c.endpoint=$2 AND c.enabled
    WHERE j.id=$1 AND j.kind='search-index' AND j.state='failed' AND j.attempts>=5 AND (j.payload->>'generation')::bigint=$3 AND j.search_recovery_generation=$3 AND j.search_recovery_count=$4 FOR SHARE OF j,c`, t.SourceID, endpoint, t.Generation, t.RecoveryAttempt)
	case jobs.ContentPublication:
		return check(`SELECT true FROM site_publications_v1 WHERE id=$1 AND endpoint=$2 AND state='queued' AND job_id=$3 AND attempts=0 AND published_at IS NULL AND result IS NULL AND error IS NULL FOR SHARE`, t.SourceID, endpoint, t.ID)
	case jobs.AccountNotice:
		return check(`SELECT true FROM operations_notices_v1 WHERE id=$1 AND endpoint=$2 AND state='queued' AND job_id=$3 AND last_attempt_at IS NULL FOR SHARE`, t.SourceID, endpoint, t.ID)
	case jobs.RetentionCleanup:
		return check(`SELECT true FROM operations_retention_runs_v1 WHERE id=$1 AND endpoint=$2 AND state='queued' AND job_id=$3 AND finished_at IS NULL FOR SHARE`, t.SourceID, endpoint, t.ID)
	case jobs.MessagingRun:
		return check(`SELECT true FROM operations_messaging_plans_v1 p JOIN operations_messaging_versions_v1 v ON v.plan_id=p.id AND v.version=p.version
    WHERE p.id=$1 AND p.endpoint=$2 AND p.state='active' AND p.version=$3 AND (p.job_id=$4 OR v.config->'schedule'->>'kind'='recurring')
    AND NOT EXISTS(SELECT 1 FROM operations_messaging_runs_v1 r WHERE r.plan_id=p.id AND r.plan_version=p.version AND r.occurrence_key=CASE WHEN v.config->'schedule'->>'kind'='recurring' THEN $4::text ELSE 'initial' END)
    FOR SHARE OF p,v`, t.SourceID, endpoint, t.PlanVersion, t.ID)
	case jobs.MessagingDelivery:
		// A previously emitted/unknown SMTP attempt is not a fresh dispatch candidate.
		// Those runs remain with their original owning reconciliation path.
		return check(`SELECT true FROM operations_messaging_runs_v1 r WHERE r.id=$1 AND r.endpoint=$2 AND r.state='running' AND r.job_id=$3
    AND NOT EXISTS(SELECT 1 FROM operations_messaging_recipients_v1 p WHERE p.run_id=r.id AND (p.attempt_count<>0 OR p.state<>'pending')) FOR SHARE OF r`, t.SourceID, endpoint, t.ID)
	case jobs.AutonomyTask:
		if reconcile, ok := t.Payload["reconcile"].(bool); ok && reconcile {
			return changed()
		}
		return check(`SELECT true FROM operations_autonomy_tasks_v1 WHERE id=$1 AND endpoint=$2 AND source<>'workbench' AND state='queued' AND dispatch_started_at IS NULL AND started_at IS NULL AND native_run_id IS NULL AND lease_owner IS NULL AND lease_until IS NULL FOR SHARE`, t.SourceID, endpoint)
	case jobs.AutonomyTick:
		prefix := endpoint + ":"
		if !strings.HasPrefix(legacy.SingletonKey, prefix) {
			return changed()
		}
		if n, e := strconv.ParseInt(strings.TrimPrefix(legacy.SingletonKey, prefix), 10, 64); e != nil || n < 0 {
			return changed()
		}
		return check(`SELECT true FROM operations_autonomy_health_v1 WHERE endpoint=$1 FOR SHARE`, endpoint)
	}
	return changed()
}

// VerifyLegacyRecurringSourceWithin binds the old technical cron definition to
// its same current active business plan/version. It creates no approval, event,
// run or recipient and deliberately does not construct a management Actor.
func VerifyLegacyRecurringSourceWithin(ctx context.Context, tx pgx.Tx, endpoint string, def jobs.LegacyRecurringSchedule, t jobs.Task) error {
	changed := func() error { return fault.New("operations_job_adoption_source_changed", 409) }
	if t.Endpoint != endpoint || t.Action != jobs.MessagingRun || t.ID != "" || t.OperationID != "" || def.Data["planId"] != t.SourceID || adoptionSourceInteger(def.Data["planVersion"]) != t.PlanVersion {
		return changed()
	}
	var found bool
	e := tx.QueryRow(ctx, `SELECT true FROM operations_messaging_plans_v1 p JOIN operations_messaging_versions_v1 v ON v.plan_id=p.id AND v.version=p.version
    WHERE p.id=$1 AND p.endpoint=$2 AND p.state='active' AND p.version=$3 AND v.config->'schedule'->>'kind'='recurring' AND v.config->'schedule'->>'cron'=$4 AND v.config->'schedule'->>'timezone'=$5 FOR SHARE OF p,v`, t.SourceID, endpoint, t.PlanVersion, def.Cron, def.Timezone).Scan(&found)
	if errors.Is(e, pgx.ErrNoRows) {
		return changed()
	}
	return e
}

// The closed payload parser has already validated these safe integral values.
// Pass native integers to PostgreSQL rather than relying on json.Number codec
// inference for int4 parameters.
func adoptionSourceInteger(v any) int64 {
	switch n := v.(type) {
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	}
	return 0
}
