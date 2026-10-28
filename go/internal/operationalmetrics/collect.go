package operationalmetrics

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
	"strconv"
	"time"
)

func numeric(value any) (float64, error) {
	if n, ok := value.(pgtype.Numeric); ok {
		v, e := n.Float64Value()
		if e != nil || !v.Valid {
			return 0, invalid()
		}
		return v.Float64, nil
	}
	n, e := strconv.ParseFloat(fmt.Sprint(value), 64)
	if e != nil || !finite(n) {
		return 0, invalid()
	}
	return n, nil
}
func (m *Metrics) collect(ctx context.Context, at time.Time) {
	c := m.options.Configuration
	if c.CostFile != "" {
		value, _ := ReadCost(c.CostFile)
		m.updateCost(value)
	}
	if c.BackupStatusDirectory != "" {
		actions := c.MonitoredBackupActions
		if len(actions) == 0 {
			actions = []string{"create", "check", "copy"}
		}
		for _, action := range actions {
			for _, name := range []string{"backup_running", "backup_last_attempt_success", "backup_started_timestamp_seconds", "backup_finished_timestamp_seconds", "backup_last_success_timestamp_seconds"} {
				m.remove(name, action)
			}
			value, e := ReadBackupStatus(c.BackupStatusDirectory, action)
			m.set("backup_status_available", flag(e == nil && value != nil), action)
			if e == nil && value != nil {
				m.set("backup_running", flag(value.Outcome == "running"), action)
				m.set("backup_started_timestamp_seconds", float64(value.StartedAt), action)
				if value.FinishedAt != nil {
					m.set("backup_finished_timestamp_seconds", float64(*value.FinishedAt), action)
					m.set("backup_last_attempt_success", flag(value.Outcome == "succeeded"), action)
				}
				if value.LastSuccessAt != nil {
					m.set("backup_last_success_timestamp_seconds", float64(*value.LastSuccessAt), action)
				}
			}
		}
	}
	if m.options.LogStatus != nil {
		func() {
			defer func() {
				if recover() != nil {
					m.set("runtime_log_ready", 0)
					m.reset("runtime_log_events")
				}
			}()
			state := m.options.LogStatus()
			m.set("runtime_log_ready", flag(state.Ready))
			for kind, value := range map[string]uint64{"writeFailures": state.WriteFailures, "droppedRecords": state.DroppedRecords, "rotationWarnings": state.RotationWarnings, "rotations": state.Rotations} {
				m.set("runtime_log_events", float64(value), kind)
			}
		}()
	}
	if m.options.Pool != nil {
		values, e := autonomySnapshot(ctx, m.options.Pool, at)
		valid := e == nil
		for _, key := range []string{"enabled", "tick_limit", "late", "stalled"} {
			if _, e := numeric(values[key]); e != nil {
				valid = false
			}
		}
		if valid {
			m.set("autonomy_collection_success", 1)
			mapping := map[string]string{"enabled": "autonomy_enabled_accounts", "tick_limit": "autonomy_worker_tick_limit_seconds", "late": "autonomy_overdue_start_tasks", "stalled": "autonomy_overdue_round_tasks"}
			for field, name := range mapping {
				n, _ := numeric(values[field])
				m.set(name, n)
			}
			available, _ := values["health_available"].(bool)
			m.set("autonomy_worker_health_available", flag(available))
			if values["tick_age"] == nil {
				m.remove("autonomy_worker_tick_age_seconds")
			} else if n, e := numeric(values["tick_age"]); e == nil {
				if n < 0 {
					n = 0
				}
				m.set("autonomy_worker_tick_age_seconds", n)
			}
		} else {
			m.set("autonomy_collection_success", 0)
			m.reset("autonomy_enabled_accounts", "autonomy_worker_health_available", "autonomy_worker_tick_age_seconds", "autonomy_worker_tick_limit_seconds", "autonomy_overdue_start_tasks", "autonomy_overdue_round_tasks")
		}
		values2, e := operationalSnapshot(ctx, m.options.Pool, at)
		if e != nil {
			m.set("database_collection_success", 0)
			m.reset("database_bytes", "jobs", "job_active_leases", "job_oldest_open_age_seconds", "revocation_open_jobs", "revocation_oldest_open_job_age_seconds", "revocation_dependent_open_jobs", "revocation_oldest_dependent_job_age_seconds", "revocation_search_documents", "product_subjects")
		} else {
			m.set("database_collection_success", 1)
			m.set("database_last_success_timestamp_seconds", float64(at.UnixMilli())/1000)
			for field, name := range map[string]string{"database_bytes": "database_bytes", "active": "job_active_leases", "oldest": "job_oldest_open_age_seconds", "revoked_jobs": "revocation_open_jobs", "oldest_revocation": "revocation_oldest_open_job_age_seconds", "dependent_revoked_jobs": "revocation_dependent_open_jobs", "oldest_dependent_revocation": "revocation_oldest_dependent_job_age_seconds", "invalidated_search_documents": "revocation_search_documents"} {
				m.set(name, values2[field])
			}
			for _, state := range []string{"pending", "running", "completed", "failed"} {
				m.set("jobs", values2[state], state)
			}
			m.set("product_subjects", values2["connected"], "connected")
			m.set("product_subjects", values2["evidence_bearing"], "evidence_bearing")
		}
	}
	if c.StorageDirectory != "" {
		total, available, e := diskSpace(c.StorageDirectory)
		if e != nil {
			m.set("storage_collection_success", 0)
			m.reset("storage_bytes")
		} else {
			m.set("storage_collection_success", 1)
			m.set("storage_bytes", float64(total), "total")
			m.set("storage_bytes", float64(available), "available")
		}
	}
}
