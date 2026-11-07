package communitygrowth

import (
	"context"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type AssessmentEvidence struct {
	SourceKey      string `json:"sourceKey"`
	SourceRevision int64  `json:"sourceRevision"`
	SourceVersion  string `json:"sourceVersion"`
}

type AssessmentResult struct {
	AccountID     string               `json:"accountId"`
	Domain        string               `json:"domain"`
	Purpose       string               `json:"purpose"`
	InputRevision int64                `json:"inputRevision"`
	ConfigVersion int64                `json:"configVersion"`
	Status        string               `json:"status"`
	Value         *float64             `json:"value"`
	Coverage      string               `json:"coverage"`
	Reason        string               `json:"reason"`
	Evidence      []AssessmentEvidence `json:"evidence"`
	Missing       []string             `json:"missing"`
}

func validAssessmentResult(x AssessmentResult) bool {
	if x.AccountID == "" || x.Domain == "" || x.Purpose == "" || x.InputRevision < 1 || x.ConfigVersion < 1 || utf8.RuneCountInString(x.Reason) > 16000 || strings.TrimSpace(x.Reason) == "" {
		return false
	}
	if x.Coverage != "none" && x.Coverage != "partial" && x.Coverage != "broad" {
		return false
	}
	if x.Status == "assessed" {
		if x.Value == nil || math.IsNaN(*x.Value) || math.IsInf(*x.Value, 0) || *x.Value < 0 || *x.Value > 1 || len(x.Evidence) == 0 || x.Coverage == "none" {
			return false
		}
	} else if x.Status != "insufficient-material" || x.Value != nil || len(x.Missing) == 0 {
		return false
	}
	seen := map[string]bool{}
	for _, ref := range x.Evidence {
		if ref.SourceKey == "" || ref.SourceRevision < 1 || ref.SourceVersion == "" || seen[ref.SourceKey] {
			return false
		}
		seen[ref.SourceKey] = true
	}
	for _, missing := range x.Missing {
		if strings.TrimSpace(missing) == "" || utf8.RuneCountInString(missing) > 2000 {
			return false
		}
	}
	return true
}

func (s *AssessmentService) SaveResult(ctx context.Context, taskID string, result AssessmentResult) (Object, error) {
	if !validAssessmentResult(result) {
		return nil, invalid()
	}
	if s.ReadSourceWithin == nil || s.TaskVersionsWithin == nil {
		return nil, assessmentNotConnected()
	}
	canonical, e := identity.Canonical(result)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(canonical)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if s.authorizeTaskWithin != nil {
			if e := s.authorizeTaskWithin(ctx, tx); e != nil {
				return nil, e
			}
		}
		task, e := s.assessmentTaskWithin(ctx, tx, taskID, false)
		if e != nil {
			return nil, e
		}
		if result.AccountID != task.AccountID || result.Domain != task.Domain || result.Purpose != task.Purpose || result.InputRevision != task.InputRevision || result.ConfigVersion != task.ConfigVersion {
			return nil, fault.New("community_assessment_result_scope_mismatch", 409)
		}
		// Configuration comes before scope in the lock order shared by config
		// adoption and worker scheduling.
		var enabled, retired bool
		var configVersion int64
		if e = tx.QueryRow(ctx, `SELECT enabled,version,retired_at IS NOT NULL FROM community_assessment_config_v1 WHERE endpoint=$1 FOR SHARE`, s.Endpoint).Scan(&enabled, &configVersion, &retired); e != nil {
			return nil, e
		}
		// The scope lock serializes source corrections against adoption without
		// holding any database transaction during model work.
		var revision int64
		var activeTask, currentResult *string
		if e = tx.QueryRow(ctx, `SELECT input_revision,task_id::text,current_result_id::text FROM community_assessment_scopes_v1 WHERE endpoint=$1 AND account_id=$2 AND domain=$3 AND purpose=$4 FOR UPDATE`, s.Endpoint, task.AccountID, task.Domain, task.Purpose).Scan(&revision, &activeTask, &currentResult); e != nil {
			return nil, e
		}
		var priorHash *string
		var taskState string
		if e = tx.QueryRow(ctx, `SELECT result_hash,state FROM community_assessment_tasks_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE`, s.Endpoint, taskID).Scan(&priorHash, &taskState); e != nil {
			return nil, e
		}
		if priorHash != nil {
			if *priorHash != hash {
				return nil, fault.New("community_assessment_result_conflict", 409)
			}
			var adopted bool
			if currentResult != nil && enabled && configVersion == task.ConfigVersion {
				if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_assessment_results_v1 WHERE endpoint=$1 AND id=$2 AND task_id=$3)`, s.Endpoint, *currentResult, taskID).Scan(&adopted); e != nil {
					return nil, e
				}
			}
			return Object{"state": taskState, "taskId": taskID, "replayed": true, "adopted": adopted}, nil
		}
		if retired {
			return nil, assessmentRetired()
		}
		if revision != task.InputRevision || activeTask == nil || *activeTask != taskID || !enabled || configVersion != task.ConfigVersion {
			_, e = tx.Exec(ctx, `UPDATE community_assessment_tasks_v1 SET state='superseded',result_hash=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, taskID, hash, s.now())
			return Object{"state": "superseded", "taskId": taskID, "adopted": false, "replayed": false}, e
		}
		// Resolve tool references back to the original manifest keys. Keep
		// stored evidence and invalidation unchanged, including old receipts.
		result.Evidence = append([]AssessmentEvidence(nil), result.Evidence...)
		seenSources := map[string]bool{}
		for index, ref := range result.Evidence {
			var source AssessmentSource
			var readVersion *string
			e = tx.QueryRow(ctx, `SELECT source_key,source_kind,source_id,source_revision,snapshot,read_version FROM community_assessment_materials_v1
				WHERE endpoint=$1 AND task_id=$2 AND (source_key=$3 OR source_kind||':'||source_id=$3)`, s.Endpoint, taskID, ref.SourceKey).
				Scan(&source.Key, &source.Kind, &source.ID, &source.Revision, &source.Snapshot, &readVersion)
			if noRows(e) || e == nil && (source.Revision != ref.SourceRevision || readVersion == nil || *readVersion != ref.SourceVersion) {
				return nil, fault.New("community_assessment_evidence_mismatch", 409)
			}
			if e != nil {
				return nil, e
			}
			if seenSources[source.Key] {
				return nil, invalid()
			}
			seenSources[source.Key] = true
			result.Evidence[index].SourceKey = source.Key
			source.ObjectKind, source.ObjectID = str(source.Snapshot, "objectKind"), str(source.Snapshot, "objectId")
			current, e := s.ReadSourceWithin(ctx, tx, source)
			if e != nil {
				return nil, e
			}
			version := str(current, "version")
			if current == nil || version == "" || version != ref.SourceVersion {
				return nil, fault.New("community_assessment_source_changed", 409)
			}
		}
		// Material already read by the model can inform its conclusion even
		// when it was omitted from the shorter cited evidence list.
		if result.Status == "assessed" {
			valid, e := s.assessmentEvidenceCurrentWithin(ctx, tx, taskID, result.Evidence)
			if e != nil {
				return nil, e
			}
			if !valid {
				return nil, fault.New("community_assessment_source_changed", 409)
			}
		}
		model, prompt, e := s.TaskVersionsWithin(ctx, tx, taskID)
		if e != nil {
			return nil, e
		}
		if model == "" || prompt == "" {
			return nil, fault.New("community_assessment_versions_unavailable", 503)
		}
		if result.Evidence == nil {
			result.Evidence = []AssessmentEvidence{}
		}
		if result.Missing == nil {
			result.Missing = []string{}
		}
		id := uuid.NewString()
		_, e = tx.Exec(ctx, `INSERT INTO community_assessment_results_v1(endpoint,id,task_id,account_id,domain,purpose,input_revision,config_version,status,value,coverage,reason,evidence,missing,model_version,prompt_version,adopted,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17)`, s.Endpoint, id, taskID, task.AccountID, task.Domain, task.Purpose, task.InputRevision, task.ConfigVersion, result.Status, result.Value, result.Coverage, result.Reason, jsonText(result.Evidence), jsonText(result.Missing), model, prompt, s.now())
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE community_assessment_tasks_v1 SET state='saved',result_hash=$3,updated_at=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, taskID, hash, s.now()); e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, `UPDATE community_assessment_scopes_v1 SET applied_revision=$5,current_result_id=$6,state='applied',last_error=NULL,updated_at=$7 WHERE endpoint=$1 AND account_id=$2 AND domain=$3 AND purpose=$4`, s.Endpoint, task.AccountID, task.Domain, task.Purpose, task.InputRevision, id, s.now())
		return Object{"state": "saved", "taskId": taskID, "resultId": id, "adopted": true, "replayed": false}, e
	})
}

// CurrentWeightWithin is for trusted server-side recommendation consumers.
// A nil value means neutral influence, including not-yet-computed and genuine
// insufficient material. The returned value must never enter portal payloads.
func (s *AssessmentService) CurrentWeightWithin(ctx context.Context, tx pgx.Tx, account, domain, purpose string) (*float64, string, error) {
	var value *float64
	var version, taskID string
	var evidence []AssessmentEvidence
	e := tx.QueryRow(ctx, `SELECT r.value,r.id::text,r.task_id::text,r.evidence FROM community_assessment_scopes_v1 x
		JOIN community_assessment_results_v1 r ON r.endpoint=x.endpoint AND r.id=x.current_result_id
		JOIN community_assessment_config_v1 c ON c.endpoint=x.endpoint AND c.enabled AND c.retired_at IS NULL AND c.version=r.config_version
		WHERE x.endpoint=$1 AND x.account_id=$2 AND x.domain=$3 AND x.purpose=$4 AND x.purpose=ANY(c.purposes) AND r.adopted AND r.status='assessed'`, s.Endpoint, account, domain, purpose).Scan(&value, &version, &taskID, &evidence)
	if noRows(e) {
		return nil, "", nil
	}
	if e != nil {
		return nil, "", e
	}
	valid, e := s.assessmentEvidenceCurrentWithin(ctx, tx, taskID, evidence)
	if e != nil || !valid {
		return nil, "", e
	}
	return value, version, e
}

// Even without a new business event, public source expiration invalidates its
// derived influence. Never reuse the cached title or an old read qualification.
func (s *AssessmentService) assessmentEvidenceCurrentWithin(ctx context.Context, tx pgx.Tx, taskID string, evidence []AssessmentEvidence) (bool, error) {
	if s.ReadSourceWithin == nil || len(evidence) == 0 {
		return false, nil
	}
	rows, e := tx.Query(ctx, `SELECT source_key,source_revision,read_version FROM community_assessment_materials_v1 WHERE endpoint=$1 AND task_id=$2 AND read_at IS NOT NULL AND read_version IS NOT NULL`, s.Endpoint, taskID)
	if e != nil {
		return false, e
	}
	all := append([]AssessmentEvidence{}, evidence...)
	for rows.Next() {
		var ref AssessmentEvidence
		if e = rows.Scan(&ref.SourceKey, &ref.SourceRevision, &ref.SourceVersion); e != nil {
			rows.Close()
			return false, e
		}
		all = append(all, ref)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return false, e
	}
	seen := map[string]bool{}
	for _, ref := range all {
		if seen[ref.SourceKey] {
			continue
		}
		seen[ref.SourceKey] = true
		var source AssessmentSource
		e := tx.QueryRow(ctx, `SELECT source_key,source_kind,source_id,source_revision,snapshot FROM community_assessment_materials_v1 WHERE endpoint=$1 AND task_id=$2 AND source_key=$3`, s.Endpoint, taskID, ref.SourceKey).
			Scan(&source.Key, &source.Kind, &source.ID, &source.Revision, &source.Snapshot)
		if noRows(e) {
			return false, nil
		}
		if e != nil {
			return false, e
		}
		source.ObjectKind, source.ObjectID = str(source.Snapshot, "objectKind"), str(source.Snapshot, "objectId")
		current, e := s.ReadSourceWithin(ctx, tx, source)
		if e != nil {
			return false, e
		}
		if current == nil || source.Revision != ref.SourceRevision || str(current, "version") == "" || str(current, "version") != ref.SourceVersion {
			return false, nil
		}
	}
	return true, nil
}
