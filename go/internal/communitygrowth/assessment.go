package communitygrowth

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// AssessmentService owns private AI calculations. Existing autonomy/AgentOS
// owns model execution, identities, human configuration and durable task runs.
type AssessmentService struct {
	*Service
	CreateTaskWithin func(context.Context, pgx.Tx, AssessmentTask) (string, error)
	ReadSourceWithin func(context.Context, pgx.Tx, AssessmentSource) (Object, error)
	// TaskStatusWithin reads the bound original autonomy task, without rerunning
	// it. A terminal task without a saved result is a failed calculation.
	TaskStatusWithin    func(context.Context, pgx.Tx, string) (string, error)
	TaskVersionsWithin  func(context.Context, pgx.Tx, string) (modelVersion, promptVersion string, err error)
	authorizeTaskWithin func(context.Context, pgx.Tx) error
}

type AssessmentTask struct {
	ID, AccountID, Domain, Purpose string
	InputRevision, ConfigVersion   int64
	Configuration                  Object
}

type AssessmentSource struct {
	Key, Kind, ID, ObjectKind, ObjectID string
	Revision                            int64
	Snapshot                            Object
}

type AssessmentWorker struct{ Service *AssessmentService }

// Serialize taking a task's configuration snapshot with human adoption.
// PostgreSQL row locks require UPDATE rights; the Worker intentionally cannot
// edit the human configuration and uses this same transaction lock instead.
func (s *AssessmentService) lockConfigurationWithin(ctx context.Context, tx pgx.Tx) error {
	_, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912768))`, "community-assessment-config:"+s.Endpoint)
	return e
}

func (s *AssessmentService) ensureAssessment(ctx context.Context, tx pgx.Tx) error {
	_, e := tx.Exec(ctx, `INSERT INTO community_assessment_config_v1(endpoint,version,updated_at) VALUES($1,1,$2) ON CONFLICT DO NOTHING`, s.Endpoint, s.now())
	return e
}

func assessmentDomains(domains []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, d := range domains {
		d = strings.TrimSpace(d)
		if d != "" && !seen[d] {
			out = append(out, d)
			seen[d] = true
		}
	}
	if len(out) == 0 {
		out = append(out, "unclassified")
	}
	sort.Strings(out)
	return out
}

// SourceChangedWithin is called by the source owner in its original business
// transaction. Replayed revisions do not generate new calculations. Include
// both the old and new domains when a contribution changes its classification.
func (s *AssessmentService) SourceChangedWithin(ctx context.Context, tx pgx.Tx, source Source) error {
	if source.AccountID == "" || source.Kind == "" || source.ID == "" || source.RuleKey == "" || source.Revision < 1 {
		return invalid()
	}
	if e := s.ensureAssessment(ctx, tx); e != nil {
		return e
	}
	var purposes []string
	if e := tx.QueryRow(ctx, `SELECT CASE WHEN retired_at IS NULL THEN purposes ELSE '{}'::text[] END
		FROM community_assessment_config_v1 WHERE endpoint=$1`, s.Endpoint).Scan(&purposes); e != nil {
		return e
	}
	if len(purposes) == 0 {
		return nil
	}
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912767))`, jsonText([]string{s.Endpoint, source.AccountID, source.Kind, source.ID, source.RuleKey})); e != nil {
		return e
	}
	var prior []string
	e := tx.QueryRow(ctx, `SELECT domains FROM community_assessment_source_revisions_v1 WHERE endpoint=$1 AND account_id=$2 AND source_kind=$3 AND source_id=$4 AND rule_key=$5 FOR UPDATE`, s.Endpoint, source.AccountID, source.Kind, source.ID, source.RuleKey).Scan(&prior)
	if e != nil && !noRows(e) {
		return e
	}
	domains := assessmentDomains(source.Domains)
	tag, e := tx.Exec(ctx, `INSERT INTO community_assessment_source_revisions_v1(endpoint,account_id,source_kind,source_id,rule_key,revision,domains) VALUES($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT(endpoint,account_id,source_kind,source_id,rule_key) DO UPDATE SET revision=excluded.revision,domains=excluded.domains
		WHERE community_assessment_source_revisions_v1.revision<excluded.revision`, s.Endpoint, source.AccountID, source.Kind, source.ID, source.RuleKey, source.Revision, domains)
	if e != nil || tag.RowsAffected() == 0 {
		return e
	}
	for _, domain := range assessmentDomains(append(domains, prior...)) {
		for _, purpose := range purposes {
			if source.Kind == "evaluation" && purpose != "evaluation-reference" {
				continue
			}
			_, e = tx.Exec(ctx, `INSERT INTO community_assessment_scopes_v1(endpoint,account_id,domain,purpose,next_attempt_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)
				ON CONFLICT(endpoint,account_id,domain,purpose) DO UPDATE SET input_revision=community_assessment_scopes_v1.input_revision+1,
				state='pending',task_id=NULL,current_result_id=CASE WHEN EXISTS(
				SELECT 1 FROM community_assessment_results_v1 r CROSS JOIN LATERAL jsonb_array_elements(r.evidence) evidence
				WHERE r.endpoint=$1 AND r.id=community_assessment_scopes_v1.current_result_id AND evidence->>'sourceKey'=jsonb_build_array($6::text,$7::text)::text)
				OR EXISTS(SELECT 1 FROM community_assessment_results_v1 r JOIN community_assessment_materials_v1 m ON m.endpoint=r.endpoint AND m.task_id=r.task_id
				WHERE r.endpoint=$1 AND r.id=community_assessment_scopes_v1.current_result_id AND m.read_at IS NOT NULL AND m.source_kind=$6 AND m.source_id=$7)
				THEN NULL ELSE community_assessment_scopes_v1.current_result_id END,
				last_error=NULL,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at`, s.Endpoint, source.AccountID, domain, purpose, s.now(), source.Kind, source.ID)
			if e != nil {
				return e
			}
		}
	}
	return nil
}

func assessmentObject(v any) Object {
	if x, ok := v.(map[string]any); ok {
		return x
	}
	return nil
}

func assessmentDecode(v any, target any) error {
	raw, e := json.Marshal(v)
	if e != nil {
		return invalid()
	}
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if e = d.Decode(target); e != nil {
		return invalid()
	}
	return nil
}

func assessmentNotConnected() error {
	return fault.New("community_assessment_not_connected", 503)
}

func assessmentRetired() error {
	return fault.New("community_assessment_retired", 409)
}
