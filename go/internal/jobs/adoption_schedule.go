package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

type LegacyRecurringSchedule struct {
	Key, Cron, Timezone string
	Data                map[string]any
}
type RecurringSourceVerifier func(context.Context, pgx.Tx, string, LegacyRecurringSchedule, Task) error

// AdoptLegacyRecurringWithin moves one original messaging definition, not a
// calendar occurrence. Old forwarded queue jobs retain their original UUIDs;
// active/unknown forwarding is never imported or replayed here. The caller
// stops old schedulers, uses the administrative transaction and keeps the Go
// gate disabled. Existing ScheduleQueue remains the only future scheduler.
func (s *ScheduleQueue) AdoptLegacyRecurringWithin(ctx context.Context, tx pgx.Tx, key string, verify RecurringSourceVerifier) (map[string]any, error) {
	if s == nil || s.Queue == nil || s.Endpoint == "" || verify == nil || !strings.HasPrefix(key, "messaging:") {
		return nil, adoptionInvalid()
	}
	parsed, err := uuid.Parse(strings.TrimPrefix(key, "messaging:"))
	if err != nil {
		return nil, adoptionInvalid()
	}
	planID := parsed.String()
	key = "messaging:" + planID
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))", s.Endpoint+":legacy-adoption"); e != nil {
		return nil, e
	}
	var backend string
	e := tx.QueryRow(ctx, "SELECT backend FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 FOR UPDATE", s.Endpoint).Scan(&backend)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	if e == nil && backend != "disabled" {
		return nil, fault.New("operations_job_adoption_requires_disabled_backend", 409)
	}
	// The legacy business key contains a colon, which pg-boss 12.38 rejects.
	// Resolve an actually persisted definition by its owning plan payload,
	// retaining its real key for forwarding-slot reads and removal. Never guess
	// among duplicate definitions or pretend the broken legacy key was stored.
	definitions, e := tx.Query(ctx, "SELECT to_jsonb(s) FROM galaxy_jobs.schedule s WHERE name='messaging-run' AND data->>'planId'=$1 LIMIT 2 FOR UPDATE", planID)
	if e != nil {
		return nil, e
	}
	var raw []byte
	if !definitions.Next() {
		e = definitions.Err()
		definitions.Close()
		if e != nil {
			return nil, e
		}
		return s.existingAdoptedScheduleWithin(ctx, tx, key, verify)
	}
	if e = definitions.Scan(&raw); e != nil {
		definitions.Close()
		return nil, e
	}
	if definitions.Next() {
		definitions.Close()
		return nil, fault.New("operations_schedule_adoption_source_ambiguous", 409)
	}
	e = definitions.Err()
	definitions.Close()
	if e != nil {
		return nil, e
	}
	var old map[string]any
	if e = protocol.Decode(raw, &old); e != nil {
		return nil, e
	}
	d, _ := old["data"].(map[string]any)
	options, _ := old["options"].(map[string]any)
	if old["kind"] != "cron" || !adoptionFields(d, []string{"planId", "planVersion"}, nil) || !watchInteger(d["planVersion"], 1) {
		return nil, adoptionInvalid()
	}
	if missed, ok := options["missed"]; ok && missed != "skip" {
		return nil, adoptionInvalid()
	}
	zone := adoptionText(old["timezone"])
	if zone == "" {
		zone = "UTC"
	}
	sourceKey := adoptionText(old["key"])
	def := LegacyRecurringSchedule{Key: sourceKey, Cron: adoptionText(old["cron"]), Timezone: zone, Data: d}
	task := Task{Endpoint: s.Endpoint, Action: MessagingRun, SourceID: adoptionText(d["planId"]), PlanVersion: adoptionInteger(d["planVersion"])}
	if task.SourceID != planID {
		return nil, adoptionInvalid()
	}
	probe := task
	probe.ID = "00000000-0000-0000-0000-000000000000"
	probe.OperationID = probe.ID
	if !probe.valid() {
		return nil, adoptionInvalid()
	}
	if e = verify(ctx, tx, s.Endpoint, def, task); e != nil {
		return nil, e
	}
	p, e := parseSchedule(def.Cron, zone)
	if e != nil {
		return nil, e
	}
	var now time.Time
	if e = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); e != nil {
		return nil, e
	}
	// The old scheduler forwards through an internal queue. Its unclaimed/active
	// envelopes have no final public job UUID yet, so they are not safe substitutes
	// for selected queue rows. Preserve them unchanged and fail explicitly.
	var pending bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM galaxy_jobs.job j WHERE j.name='__pgboss__send-it' AND j.data->>'name'='messaging-run' AND (j.data->>'key'=$1 OR (j.data->'data'->>'planId'=$2 AND j.data->'data'->>'planVersion'=$3)) AND j.state IN('created','retry','active'))`, sourceKey, task.SourceID, jsonNumber(task.PlanVersion)).Scan(&pending); e != nil {
		return nil, e
	}
	if pending {
		return nil, fault.New("operations_schedule_adoption_forward_pending", 409)
	}
	// Refuse a new independent definition if a real current Go one already exists.
	var existing bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.schedules_v1 WHERE endpoint=$1 AND queue='messaging-run' AND key=$2)", s.Endpoint, key).Scan(&existing); e != nil {
		return nil, e
	}
	if existing {
		return nil, fault.New("operations_job_adoption_conflict", 409)
	}
	last, next := p.previous(now), p.next(now)
	if last.IsZero() || next.IsZero() {
		return nil, scheduleInvalid()
	}
	suppressed := false
	if last.After(now.Add(-time.Minute)) {
		slot := last.UTC().Truncate(time.Minute)
		rows, e := tx.Query(ctx, `SELECT state::text FROM galaxy_jobs.job WHERE name='__pgboss__send-it' AND data->>'name'='messaging-run' AND data->>'key'=$1 AND singleton_on=$2::timestamp FOR SHARE`, sourceKey, slot.UTC().Format("2006-01-02 15:04:05"))
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var state string
			if e = rows.Scan(&state); e != nil {
				rows.Close()
				return nil, e
			}
			if state != "completed" && state != "failed" {
				rows.Close()
				return nil, fault.New("operations_schedule_adoption_slot_unknown", 409)
			}
			suppressed = true
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		if suppressed {
			// An old minute already filed/attempted is not a new occurrence merely
			// because River would derive another technical UUID for that minute.
			end := slot.Add(time.Minute)
			if next.Before(end) {
				next = end
			}
		} else {
			// Missing bookkeeping is not proof of non-dispatch. A recent target without
			// the exact forwarding slot must be reconciled instead of regenerated.
			var ambiguous bool
			if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM galaxy_jobs.job WHERE name='messaging-run' AND data->>'planId'=$1 AND data->>'planVersion'=$2 AND created_on>$3)`, task.SourceID, jsonNumber(task.PlanVersion), now.Add(-time.Minute)).Scan(&ambiguous); e != nil {
				return nil, e
			}
			if ambiguous {
				return nil, fault.New("operations_schedule_adoption_slot_unknown", 409)
			}
			next = now
		}
	}
	if strings.Contains(def.Cron, "H") && next.After(now.Add(30*time.Second)) {
		next = now.Add(30 * time.Second)
		if suppressed && next.Before(last.UTC().Truncate(time.Minute).Add(time.Minute)) {
			next = last.UTC().Truncate(time.Minute).Add(time.Minute)
		}
	}
	payload, e := json.Marshal(task)
	if e != nil {
		return nil, e
	}
	created, e := time.Parse(time.RFC3339Nano, adoptionText(old["created_on"]))
	if e != nil {
		return nil, adoptionInvalid()
	}
	updated, e := time.Parse(time.RFC3339Nano, adoptionText(old["updated_on"]))
	if e != nil {
		return nil, adoptionInvalid()
	}
	if _, e = tx.Exec(ctx, `INSERT INTO galaxy_go_jobs.schedules_v1(endpoint,queue,key,cron,timezone,payload,missed,next_at,revision,created_at,updated_at) VALUES($1,'messaging-run',$2,$3,$4,$5,'skip',$6,1,$7,$8)`, s.Endpoint, key, def.Cron, zone, payload, next, created, updated); e != nil {
		return nil, e
	}
	// Moving this one definition prevents a restarted old scheduler from emitting
	// its future slots. No old job, business approval, run or receipt is removed.
	if _, e = tx.Exec(ctx, "DELETE FROM galaxy_jobs.schedule WHERE name='messaging-run' AND key=$1", sourceKey); e != nil {
		return nil, e
	}
	return map[string]any{"key": key, "legacyKey": sourceKey, "planId": task.SourceID, "planVersion": task.PlanVersion, "nextAt": next.UTC().Format(time.RFC3339Nano), "oldMinuteSuppressed": suppressed, "gateChanged": false, "oldConsumersStoppedVerified": false}, nil
}
func jsonNumber(n int64) string { b, _ := json.Marshal(n); return string(b) }
func (s *ScheduleQueue) existingAdoptedScheduleWithin(ctx context.Context, tx pgx.Tx, key string, verify RecurringSourceVerifier) (map[string]any, error) {
	var expression, zone, missed string
	var raw []byte
	var next time.Time
	e := tx.QueryRow(ctx, "SELECT cron,timezone,payload,missed,next_at FROM galaxy_go_jobs.schedules_v1 WHERE endpoint=$1 AND queue='messaging-run' AND key=$2 FOR SHARE", s.Endpoint, key).Scan(&expression, &zone, &raw, &missed, &next)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fault.New("operations_schedule_not_found", 404)
	}
	if e != nil {
		return nil, e
	}
	var task Task
	if e = protocol.Decode(raw, &task); e != nil || task.Endpoint != s.Endpoint || task.Action != MessagingRun || task.ID != "" || task.OperationID != "" || missed != "skip" {
		return nil, adoptionInvalid()
	}
	def := LegacyRecurringSchedule{Key: key, Cron: expression, Timezone: zone, Data: map[string]any{"planId": task.SourceID, "planVersion": task.PlanVersion}}
	if e = verify(ctx, tx, s.Endpoint, def, task); e != nil {
		return nil, e
	}
	return map[string]any{"key": key, "planId": task.SourceID, "planVersion": task.PlanVersion, "nextAt": next.UTC().Format(time.RFC3339Nano), "state": "already-configured", "gateChanged": false, "oldConsumersStoppedVerified": false}, nil
}
