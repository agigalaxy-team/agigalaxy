package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// LegacyPendingJob retains only selected pg-boss transport/source metadata.
// It contains no reconstructed identity, authority or external result.
type LegacyPendingJob struct {
	ID, Queue, SingletonKey string
	Data                    map[string]any
}
type AdoptionSourceVerifier func(context.Context, pgx.Tx, string, LegacyPendingJob, Task) error

func adoptionInvalid() error    { return fault.New("operations_job_adoption_invalid", 400) }
func adoptionText(v any) string { s, _ := v.(string); return s }
func adoptionInteger(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}
func adoptionFields(m map[string]any, required, optional []string) bool {
	if m == nil {
		return false
	}
	for _, k := range required {
		if _, ok := m[k]; !ok {
			return false
		}
	}
	for k := range m {
		found := false
		for _, v := range append(append([]string{}, required...), optional...) {
			if k == v {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// ParseLegacyPendingTask translates only the nine original closed queue payloads.
// Task.ID is the old public queue UUID. Business source/operation IDs never get
// replaced to satisfy a new transport convention.
func ParseLegacyPendingTask(endpoint string, j LegacyPendingJob) (Task, string, error) {
	t := Task{ID: j.ID, Endpoint: endpoint, Action: j.Queue, OperationID: j.ID}
	d := j.Data
	key := ""
	switch j.Queue {
	case InformationWatch:
		if !adoptionFields(d, []string{"watchId", "subjectId", "revision", "checkRevision"}, nil) {
			return t, key, adoptionInvalid()
		}
		t.SourceID = adoptionText(d["watchId"])
		t.Payload = d
		key = fmt.Sprintf("watch:%s:%d:%d", t.SourceID, adoptionInteger(d["revision"]), adoptionInteger(d["checkRevision"]))
		if j.SingletonKey != key {
			return t, key, adoptionInvalid()
		}
	case SearchRecovery:
		if !adoptionFields(d, []string{"jobId", "generation", "recoveryAttempt"}, []string{"subjectId"}) || !watchInteger(d["generation"], 1) || !watchInteger(d["recoveryAttempt"], 1) {
			return t, key, adoptionInvalid()
		}
		t.SourceID = adoptionText(d["jobId"])
		t.Generation = adoptionInteger(d["generation"])
		t.RecoveryAttempt = int(adoptionInteger(d["recoveryAttempt"]))
	case ContentPublication, AccountNotice, RetentionCleanup, MessagingDelivery:
		field := map[string]string{ContentPublication: "publicationId", AccountNotice: "noticeId", RetentionCleanup: "runId", MessagingDelivery: "runId"}[j.Queue]
		if !adoptionFields(d, []string{field}, nil) {
			return t, key, adoptionInvalid()
		}
		t.SourceID = adoptionText(d[field])
		if j.Queue == ContentPublication || j.Queue == RetentionCleanup {
			t.OperationID = t.SourceID
		}
	case MessagingRun:
		if !adoptionFields(d, []string{"planId", "planVersion"}, nil) || !watchInteger(d["planVersion"], 1) {
			return t, key, adoptionInvalid()
		}
		t.SourceID = adoptionText(d["planId"])
		t.PlanVersion = adoptionInteger(d["planVersion"])
	case AutonomyTask:
		if !adoptionFields(d, []string{"taskId"}, []string{"reconcile"}) {
			return t, key, adoptionInvalid()
		}
		t.SourceID = adoptionText(d["taskId"])
		t.Payload = d
		key = j.SingletonKey
		if key == "" {
			return t, key, adoptionInvalid()
		}
	case AutonomyTick:
		if !adoptionFields(d, nil, nil) {
			return t, key, adoptionInvalid()
		}
		t.SourceID = t.ID
		key = j.SingletonKey
		if key == "" {
			return t, key, adoptionInvalid()
		}
	default:
		return t, key, adoptionInvalid()
	}
	// Normalize JSON numbers exactly once, through the same Task encoder used by
	// normal enqueue/hash verification. Signed business payloads are not touched.
	raw, e := json.Marshal(t)
	if e != nil {
		return t, key, e
	}
	var normalized Task
	if e = protocol.Decode(raw, &normalized); e != nil || !normalized.valid() {
		return t, key, adoptionInvalid()
	}
	return normalized, key, nil
}
