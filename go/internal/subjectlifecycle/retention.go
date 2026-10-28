package subjectlifecycle

import (
	"context"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

type RetentionConsumer func(context.Context, pgx.Tx, int64) (Object, error)

// RetentionConsumers are the existing domain-owned cleanup functions. All run
// in the same Worker transaction and in the original order. In particular an
// unavailable external outcome eraser cannot be reported as completed cleanup.
type RetentionConsumers struct {
	PrivateConversations, IdentityGroups, Hubs                                RetentionConsumer
	TaskSnapshots                                                             TaskRedactors
	TaskMaterials, Forum, WatchControls, TargetGovernance                     RetentionConsumer
	InformationWatches, TaskComments, QualificationRequests, OutcomeMaterials RetentionConsumer
}

// CleanupRetentionWithin is the original bounded product-v2 retention pass.
// It does not start a timer, create approval, expire relationship/result facts,
// or claim that database cleanup erased backups or uncontrolled copies.
func CleanupRetentionWithin(ctx context.Context, tx pgx.Tx, at int64, c RetentionConsumers) (Object, error) {
	if at < 0 || at > 9007199254740991 {
		return nil, errors.New("invalid lifecycle clock")
	}
	if c.PrivateConversations == nil || c.IdentityGroups == nil || c.Hubs == nil || c.TaskMaterials == nil || c.Forum == nil || c.WatchControls == nil || c.TargetGovernance == nil || c.InformationWatches == nil || c.TaskComments == nil || c.QualificationRequests == nil || c.OutcomeMaterials == nil {
		return nil, fault.New("lifecycle_retention_consumer_unavailable", 503)
	}
	removed := Object{}
	merge := func(fn RetentionConsumer) error {
		result, e := fn(ctx, tx, at)
		if e != nil {
			return e
		}
		for k, v := range result {
			removed[k] = v
		}
		return nil
	}
	for _, fn := range []RetentionConsumer{c.PrivateConversations, c.TaskMaterials, c.Forum, c.WatchControls, c.IdentityGroups, c.TargetGovernance, c.InformationWatches, c.Hubs, c.TaskComments, c.QualificationRequests, c.OutcomeMaterials} {
		if e := merge(fn); e != nil {
			return nil, e
		}
	}
	snapshots, e := cleanupCommonRetentionWithin(ctx, tx, at, removed, c.TaskSnapshots)
	if e != nil {
		return nil, e
	}
	return Object{"removed": removed, "snapshotsRedacted": snapshots, "maximumRowsPerCategory": 100, "backupStarted": false, "cryptoMeaning": "original-hash-retained; erased-original-bytes-not-reverifiable", "relationshipAndResultFactsAutomaticallyExpired": false}, nil
}

func cleanupCommonRetentionWithin(ctx context.Context, tx pgx.Tx, at int64, removed Object, redactors TaskRedactors) (int, error) {
	const day = int64(86400)
	iso := func(seconds int64) time.Time { return time.Unix(seconds, 0) }
	commands := []struct {
		name, sql string
		cutoff    int64
	}{
		{"trustPackagePermissionReceipts", `DELETE FROM trust_package_permissions WHERE id IN (SELECT id FROM trust_package_permissions WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 100)`, at - 180*day},
	}
	for _, command := range commands {
		result, e := tx.Exec(ctx, command.sql, iso(command.cutoff))
		if e != nil {
			return 0, e
		}
		removed[command.name] = result.RowsAffected()
	}
	contexts, e := rows(ctx, tx, `SELECT id,subject_id,payload_hash FROM context_grants_v2 WHERE expires_at<=$1 AND payload_text<>'' ORDER BY expires_at,id LIMIT 100 FOR UPDATE`, iso(at))
	if e != nil {
		return 0, e
	}
	contextIDs := []string{}
	for _, row := range contexts {
		if e = recordErasure(ctx, tx, "context_grants_v2", text(row["id"]), text(row["subject_id"]), row["payload_hash"], DeletionInfo{At: at, RetainedUntil: at + 180*day}, "temporary-content-expired"); e != nil {
			return 0, e
		}
		contextIDs = append(contextIDs, text(row["id"]))
	}
	removed["expiredContextBodies"] = int64(0)
	if len(contextIDs) > 0 {
		result, e := tx.Exec(ctx, `UPDATE context_grants_v2 SET payload_text='',erased_at=COALESCE(erased_at,$2) WHERE id=ANY($1::uuid[])`, contextIDs, iso(at))
		if e != nil {
			return 0, e
		}
		removed["expiredContextBodies"] = result.RowsAffected()
	}
	commands = []struct {
		name, sql string
		cutoff    int64
	}{
		{"identityOperations", `DELETE FROM identity_control_operations WHERE id IN (SELECT id FROM identity_control_operations WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 100)`, at - day},
		{"dailyUsage", `DELETE FROM community_daily_usage WHERE (account_id,day,category) IN (SELECT account_id,day,category FROM community_daily_usage WHERE day<$1::date ORDER BY day,account_id,category LIMIT 100)`, at - 30*day},
		{"writeReceipts", `DELETE FROM community_write_receipts WHERE (account_id,category,operation_id) IN (SELECT account_id,category,operation_id FROM community_write_receipts WHERE created_at<=$1 ORDER BY created_at,account_id,operation_id LIMIT 100)`, at - 180*day},
	}
	for _, command := range commands {
		result, e := tx.Exec(ctx, command.sql, iso(command.cutoff))
		if e != nil {
			return 0, e
		}
		removed[command.name] = result.RowsAffected()
	}
	events, e := rows(ctx, tx, `SELECT id,task_id,subject_id,payload_hash FROM task_events WHERE kind=ANY($1::text[]) AND created_at<=$2 AND payload_text<>'' ORDER BY task_id,id LIMIT 100`, []string{"suggest-contacts", "invite", "invitation-reply", "apply", "withdraw-application", "revoke-invitation"}, iso(at-90*day))
	if e != nil {
		return 0, e
	}
	snapshots := 0
	removed["temporaryTaskBodies"] = int64(0)
	if len(events) > 0 {
		result, e := redactTaskCopiesWithin(ctx, tx, events, DeletionInfo{At: at, RetainedUntil: at + 180*day}, "temporary-content-expired", redactors)
		if e != nil {
			return 0, e
		}
		snapshots = int(integer(result["snapshotsRedacted"]))
		ids := []string{}
		for _, event := range events {
			ids = append(ids, text(event["id"]))
		}
		updated, e := tx.Exec(ctx, `UPDATE task_events SET payload_text='' WHERE id=ANY($1::uuid[]) AND payload_text<>''`, ids)
		if e != nil {
			return 0, e
		}
		removed["temporaryTaskBodies"] = updated.RowsAffected()
	}
	contacts, e := rows(ctx, tx, `SELECT operation_id,subject_id,payload_hash FROM contact_events_v2 WHERE payload_text<>'' AND created_at<=$1 ORDER BY created_at,operation_id LIMIT 100`, iso(at-90*day))
	if e != nil {
		return 0, e
	}
	ids := []string{}
	for _, event := range contacts {
		if e = recordErasure(ctx, tx, "contact_events_v2", text(event["operation_id"]), text(event["subject_id"]), event["payload_hash"], DeletionInfo{At: at, RetainedUntil: at + 180*day}, "temporary-content-expired"); e != nil {
			return 0, e
		}
		ids = append(ids, text(event["operation_id"]))
	}
	removed["temporaryContactBodies"] = int64(0)
	if len(ids) > 0 {
		result, e := tx.Exec(ctx, `UPDATE contact_events_v2 SET payload_text='' WHERE operation_id=ANY($1::uuid[])`, ids)
		if e != nil {
			return 0, e
		}
		removed["temporaryContactBodies"] = result.RowsAffected()
	}
	result, e := tx.Exec(ctx, `DELETE FROM lifecycle_erasure_records WHERE id IN (SELECT id FROM lifecycle_erasure_records WHERE retained_until<=$1 ORDER BY retained_until,id LIMIT 100)`, iso(at))
	if e != nil {
		return 0, e
	}
	removed["erasureReceipts"] = result.RowsAffected()
	return snapshots, nil
}
