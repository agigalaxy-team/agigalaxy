package communitygrowth

import (
	"context"
	"encoding/base64"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *AssessmentService) assessmentTaskWithin(ctx context.Context, tx pgx.Tx, id string, current bool) (AssessmentTask, error) {
	var task AssessmentTask
	if _, e := uuid.Parse(id); e != nil {
		return task, invalid()
	}
	e := tx.QueryRow(ctx, `SELECT id::text,account_id::text,domain,purpose,input_revision,config_version,configuration FROM community_assessment_tasks_v1 WHERE endpoint=$1 AND id=$2 AND native_task_id=$2`, s.Endpoint, id).
		Scan(&task.ID, &task.AccountID, &task.Domain, &task.Purpose, &task.InputRevision, &task.ConfigVersion, &task.Configuration)
	if noRows(e) {
		return task, fault.New("community_assessment_task_not_found", 404)
	}
	if e != nil || !current {
		return task, e
	}
	var valid bool
	e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_assessment_scopes_v1 x JOIN community_assessment_config_v1 c ON c.endpoint=x.endpoint
		WHERE x.endpoint=$1 AND x.account_id=$2 AND x.domain=$3 AND x.purpose=$4 AND x.input_revision=$5 AND x.task_id=$6 AND c.enabled AND c.version=$7)`, s.Endpoint, task.AccountID, task.Domain, task.Purpose, task.InputRevision, task.ID, task.ConfigVersion).Scan(&valid)
	if e == nil && !valid {
		e = fault.New("community_assessment_source_changed", 409)
	}
	return task, e
}

func assessmentSourceFrom(key, kind, id string, revision int64, snapshot Object) AssessmentSource {
	return AssessmentSource{Key: key, Kind: kind, ID: id, Revision: revision, Snapshot: snapshot,
		ObjectKind: str(snapshot, "objectKind"), ObjectID: str(snapshot, "objectId")}
}

// ReadMaterials exposes only the server-selected community sources of this
// calculation. It never reads usage analytics, bookmarks or private relations.
// Each original object is resolved through its owning public-read service.
func (s *AssessmentService) ReadMaterials(ctx context.Context, taskID, after string, limit int) (Object, error) {
	if s.ReadSourceWithin == nil {
		return nil, assessmentNotConnected()
	}
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 100 {
		return nil, invalid()
	}
	var cursor string
	if after != "" {
		raw, e := base64.RawURLEncoding.DecodeString(after)
		if e != nil || len(raw) > 2000 {
			return nil, invalid()
		}
		cursor = string(raw)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if s.authorizeTaskWithin != nil {
			if e := s.authorizeTaskWithin(ctx, tx); e != nil {
				return nil, e
			}
		}
		task, e := s.assessmentTaskWithin(ctx, tx, taskID, true)
		if e != nil {
			return nil, e
		}
		rows, e := tx.Query(ctx, `SELECT source_key,source_kind,source_id,source_revision,snapshot FROM community_assessment_materials_v1 WHERE endpoint=$1 AND task_id=$2 AND source_key>$3 ORDER BY source_key LIMIT $4`, s.Endpoint, taskID, cursor, limit+1)
		if e != nil {
			return nil, e
		}
		sources := []AssessmentSource{}
		for rows.Next() {
			var key, kind, id string
			var revision int64
			var snapshot Object
			if e = rows.Scan(&key, &kind, &id, &revision, &snapshot); e != nil {
				rows.Close()
				return nil, e
			}
			sources = append(sources, assessmentSourceFrom(key, kind, id, revision, snapshot))
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		more := len(sources) > limit
		if more {
			sources = sources[:limit]
		}
		items := []Object{}
		for _, source := range sources {
			material, e := s.ReadSourceWithin(ctx, tx, source)
			if e != nil {
				return nil, e
			}
			// Missing or withdrawn material remains a gap. Cached manifest
			// titles are not returned as a substitute for a current source.
			if material == nil {
				items = append(items, Object{"sourceKey": source.Kind + ":" + source.ID, "sourceRevision": source.Revision, "availability": "unavailable"})
				continue
			}
			version := str(material, "version")
			if version == "" {
				return nil, fault.New("community_assessment_source_version_unavailable", 503)
			}
			if _, e = tx.Exec(ctx, `UPDATE community_assessment_materials_v1 SET read_version=$4,read_at=$5 WHERE endpoint=$1 AND task_id=$2 AND source_key=$3`, s.Endpoint, taskID, source.Key, version, s.now()); e != nil {
				return nil, e
			}
			// The tool reference is plain text, not the internal JSON tuple. It
			// also works for manifests created before this representation change.
			items = append(items, Object{"sourceKey": source.Kind + ":" + source.ID, "sourceKind": source.Kind, "sourceId": source.ID, "sourceRevision": source.Revision,
				"sourceVersion": version, "availability": "available", "source": source.Snapshot, "material": material})
		}
		var count int
		if e = tx.QueryRow(ctx, `SELECT count(*)::int FROM community_assessment_materials_v1 WHERE endpoint=$1 AND task_id=$2`, s.Endpoint, taskID).Scan(&count); e != nil {
			return nil, e
		}
		var next any
		if more && len(sources) > 0 {
			next = base64.RawURLEncoding.EncodeToString([]byte(sources[len(sources)-1].Key))
		}
		var receipt Object
		e = tx.QueryRow(ctx, `SELECT jsonb_build_object('state','saved','resultId',id,'taskId',task_id) FROM community_assessment_results_v1 WHERE endpoint=$1 AND task_id=$2`, s.Endpoint, taskID).Scan(&receipt)
		if e != nil && !noRows(e) {
			return nil, e
		}
		return Object{"taskId": task.ID, "accountId": task.AccountID, "domain": task.Domain, "purpose": task.Purpose,
			"inputRevision": task.InputRevision, "configVersion": task.ConfigVersion, "instructions": task.Configuration["instructions"], "purposeInstruction": str(task.Configuration, "purposeInstruction"),
			"items": items, "totalSources": count, "nextAfter": next, "coverage": "this-page", "resultReceipt": receipt,
			"sourceMeaning":   "Each sourceKey is one source; ruleKeys and its original content are not separate contributions.",
			"previousWeights": "Not contribution evidence; no private or analytics-only material included."}, nil
	})
}

// TaskTools is wired only after the existing autonomy endpoint has authorized
// the precise task/run/call. Public and portal-account handlers must not expose
// this trusted task callback as a general account query.
func (s *AssessmentService) TaskTools(ctx context.Context, taskID, tool string, args Object) (Object, error) {
	switch tool {
	case "read-community-assessment-material":
		for key := range args {
			if key != "after" && key != "limit" {
				return nil, invalid()
			}
		}
		limit := int64(20)
		if value, ok := args["limit"]; ok {
			var valid bool
			limit, valid = integer(value)
			if !valid || limit < 1 || limit > 100 {
				return nil, invalid()
			}
		}
		return s.ReadMaterials(ctx, taskID, str(args, "after"), int(limit))
	case "save-community-assessment-result":
		var result AssessmentResult
		if e := assessmentDecode(args, &result); e != nil {
			return nil, e
		}
		return s.SaveResult(ctx, taskID, result)
	default:
		return nil, invalid()
	}
}

// TaskToolsAuthorized lets the existing engine recheck its opaque original
// task/run/attempt actor in the actual material/result transaction. The clone
// is local to this call; concurrent tasks cannot replace each other's guard.
func (s *AssessmentService) TaskToolsAuthorized(ctx context.Context, taskID, tool string, args Object, authorize func(context.Context, pgx.Tx) error) (Object, error) {
	if authorize == nil {
		return nil, assessmentNotConnected()
	}
	copy := *s
	copy.authorizeTaskWithin = authorize
	return copy.TaskTools(ctx, taskID, tool, args)
}
