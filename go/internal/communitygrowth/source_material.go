package communitygrowth

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

// AssessmentSourceWithin resolves the same current public facts used by growth
// display. The manifest identifies material; it cannot keep withdrawn text or
// a cancelled interaction alive merely by retaining its old title.
func (s *Service) AssessmentSourceWithin(ctx context.Context, tx pgx.Tx, source AssessmentSource) (Object, error) {
	account := str(source.Snapshot, "accountId")
	if account == "" {
		return nil, nil
	}
	var r growthRow
	var revision int64
	e := tx.QueryRow(ctx, `SELECT source_kind,source_id,rule_key,title,object_kind,object_id,domains,occurred_at,revision
	 FROM community_growth_sources_v1 WHERE endpoint=$1 AND account_id=$2 AND source_kind=$3 AND source_id=$4 AND active
	 ORDER BY revision DESC,rule_key LIMIT 1`, s.Endpoint, account, source.Kind, source.ID).
		Scan(&r.Kind, &r.ID, &r.Rule, &r.Title, &r.ObjectKind, &r.ObjectID, &r.Domains, &r.At, &revision)
	if noRows(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if revision != source.Revision {
		return nil, nil
	}
	view, e := s.ReadEligibleWithin(ctx, tx, r.ObjectKind, r.ObjectID)
	if e != nil || view == nil {
		return nil, e
	}
	current, e := s.currentGrowthSourceWithin(ctx, tx, account, r, view)
	if e != nil || !current {
		return nil, e
	}
	facts := Object{"kind": r.Kind, "accountId": account, "domains": r.Domains, "occurredAt": r.At, "revision": revision}
	if r.Kind == "recognition" || r.Kind == "activity" || r.Kind == "honor" {
		var recognition Object
		e = tx.QueryRow(ctx, `SELECT jsonb_build_object('kind',x.kind,'reason',x.reason,'domain',x.domain,'createdAt',x.created_at,
		 'revision',x.revision,'honor',CASE WHEN x.kind='honor' THEN jsonb_build_object('name',d.name,'description',d.description) ELSE NULL END)
		 FROM community_growth_recognitions_v1 x LEFT JOIN community_growth_definitions_v1 d ON d.endpoint=x.endpoint AND d.id=x.definition_id
		 WHERE x.endpoint=$1 AND x.id=$2 AND x.account_id=$3 AND x.active AND x.revision=$4`, s.Endpoint, r.ID, account, revision).Scan(&recognition)
		if noRows(e) {
			return nil, nil
		}
		if e != nil {
			return nil, e
		}
		facts["recognition"] = recognition
	}
	// A content version, source revision, and current curation each affect the
	// material. Serialize them together rather than mistaking source sequence
	// numbers for the content's own publication version.
	versionFields := Object{"source": revision, "locator": view["locator"], "head": view["headVersion"], "versionId": view["currentVersionId"], "curation": view["operatorCuration"], "facts": facts}
	raw, e := json.Marshal(versionFields)
	if e != nil {
		return nil, e
	}
	return Object{"version": identity.Digest(raw), "facts": facts, "content": view}, nil
}
