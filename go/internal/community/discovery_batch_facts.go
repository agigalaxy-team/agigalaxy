package community

import (
	"context"
	"github.com/jackc/pgx/v5"
)

type discoveryPermissionFact struct {
	permission, evidence Object
	official, deletion   bool
}

// A page-local fact set is read within the caller's repeatable-read snapshot.
type discoveryFacts struct {
	permissions map[string]discoveryPermissionFact
	sections    map[string]Object
	hides       map[string]bool
	curations   map[string]Object
	tags        map[string][]Object
	accounts    map[string]bool
}

func batchIDs(values ...string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range values {
		if validID(v) && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
func (s *Service) discoveryPermissionFacts(ctx context.Context, tx pgx.Tx, ids []string) (map[string]discoveryPermissionFact, error) {
	out := map[string]discoveryPermissionFact{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, e := tx.Query(ctx, `SELECT p.id::text,to_jsonb(p),CASE WHEN c.id IS NOT NULL AND b.id IS NOT NULL THEN to_jsonb(c)||jsonb_build_object('binding_revoked',b.revoked_at,'revocation_kind',b.revocation_kind,'revocation_event_kind',ce.kind,'revocation_event_subject',ce.subject_id,'binding_id',b.id) ELSE NULL END,
 EXISTS(SELECT 1 FROM community_accounts a JOIN (SELECT id,account_id,actor_kind,subject_id,consent_id,payload_hash,erased_at FROM forum_events_v1 UNION ALL SELECT id,account_id,actor_kind,subject_id,consent_id,payload_hash,erased_at FROM forum_governance_events_v1) ev ON ev.id=p.event_id AND ev.account_id=a.id WHERE a.id=p.account_id AND a.endpoint=$2 AND ev.actor_kind='official-account' AND ev.subject_id IS NULL AND ev.consent_id IS NULL AND ev.payload_hash=p.payload_hash AND ev.erased_at IS NULL),
 EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=p.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))
 FROM forum_permissions_v1 p LEFT JOIN consents c ON c.id=p.consent_id LEFT JOIN bindings b ON b.id=p.origin_binding_id LEFT JOIN subject_control_events ce ON ce.id=b.revocation_control_event_id WHERE p.id=ANY($1::uuid[])`, ids, s.Endpoint)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var fact discoveryPermissionFact
		if e = rows.Scan(&id, &fact.permission, &fact.evidence, &fact.official, &fact.deletion); e != nil {
			return nil, e
		}
		out[id] = fact
	}
	return out, rows.Err()
}
func (s *Service) discoveryPermissionAllowed(f discoveryPermissionFact, source Object, action, id string) bool {
	if permissionBaseState(f.permission, source, action, id, "Public", s.clock()) != "continue" {
		return false
	}
	if str(f.permission, "authorization_kind") == "official-account" {
		return f.official
	}
	return permissionConsentState(f.permission, f.evidence, action, id, "Public", s.Endpoint, s.clock()) == "continue" && !f.deletion
}
func (s *Service) discoveryAuxiliaryFacts(ctx context.Context, tx pgx.Tx, source []Object, postIDs, replyIDs []string) (*discoveryFacts, error) {
	f := &discoveryFacts{permissions: map[string]discoveryPermissionFact{}, sections: map[string]Object{}, hides: map[string]bool{}, curations: map[string]Object{}, tags: map[string][]Object{}, accounts: map[string]bool{}}
	permissions, sections, accounts := []string{}, []string{}, []string{}
	for _, r := range source {
		permissions = append(permissions, str(r, "permission_id"))
		sections = append(sections, str(r, "section_id"))
		accounts = append(accounts, str(r, "account_id"))
	}
	var e error
	f.permissions, e = s.discoveryPermissionFacts(ctx, tx, batchIDs(permissions...))
	if e != nil {
		return nil, e
	}
	resultRows, e := tx.Query(ctx, `SELECT id::text,to_jsonb(s) FROM forum_sections_v2 s WHERE id=ANY($1::uuid[])`, batchIDs(sections...))
	if e != nil {
		return nil, e
	}
	for resultRows.Next() {
		var id string
		var v Object
		if e = resultRows.Scan(&id, &v); e != nil {
			resultRows.Close()
			return nil, e
		}
		f.sections[id] = v
	}
	e = resultRows.Err()
	resultRows.Close()
	if e != nil {
		return nil, e
	}
	all := append(append(append([]string{}, postIDs...), replyIDs...), sections...)
	resultRows, e = tx.Query(ctx, `SELECT target_kind,target_id::text FROM operations_content_visibility_v1 WHERE endpoint=$1 AND target_id=ANY($2::uuid[]) AND hidden_until>$3`, s.Endpoint, batchIDs(all...), s.now())
	if e != nil {
		return nil, e
	}
	for resultRows.Next() {
		var k, id string
		if e = resultRows.Scan(&k, &id); e != nil {
			resultRows.Close()
			return nil, e
		}
		f.hides[k+":"+id] = true
	}
	e = resultRows.Err()
	resultRows.Close()
	if e != nil {
		return nil, e
	}
	resultRows, e = tx.Query(ctx, `SELECT target_kind,target_id::text,to_jsonb(c) FROM operations_forum_curation_v1 c WHERE endpoint=$1 AND ((target_kind='post' AND target_id=ANY($2::uuid[])) OR (target_kind='reply' AND target_id=ANY($3::uuid[])))`, s.Endpoint, batchIDs(postIDs...), batchIDs(replyIDs...))
	if e != nil {
		return nil, e
	}
	tagIDs := []string{}
	for resultRows.Next() {
		var k, id string
		var v Object
		if e = resultRows.Scan(&k, &id, &v); e != nil {
			resultRows.Close()
			return nil, e
		}
		f.curations[k+":"+id] = v
		if ids, ok := v["tag_ids"].([]any); ok {
			for _, id := range ids {
				tagIDs = append(tagIDs, asString(id))
			}
		}
	}
	e = resultRows.Err()
	resultRows.Close()
	if e != nil {
		return nil, e
	}
	tags, e := rows(ctx, tx, `SELECT jsonb_build_object('id',id,'name',name,'version',revision,'enabled',enabled,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM operations_forum_tags_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[]) AND enabled=true ORDER BY name,id`, s.Endpoint, batchIDs(tagIDs...))
	if e != nil {
		return nil, e
	}
	for key, curation := range f.curations {
		wanted := map[string]bool{}
		if ids, ok := curation["tag_ids"].([]any); ok {
			for _, id := range ids {
				wanted[asString(id)] = true
			}
		}
		f.tags[key] = []Object{}
		for _, tag := range tags {
			if wanted[str(tag, "id")] {
				f.tags[key] = append(f.tags[key], tag)
			}
		}
	}
	resultRows, e = tx.Query(ctx, `SELECT id::text FROM community_accounts WHERE endpoint=$1 AND id=ANY($2::uuid[])`, s.Endpoint, batchIDs(accounts...))
	if e != nil {
		return nil, e
	}
	for resultRows.Next() {
		var id string
		if e = resultRows.Scan(&id); e != nil {
			resultRows.Close()
			return nil, e
		}
		f.accounts[id] = true
	}
	e = resultRows.Err()
	resultRows.Close()
	return f, e
}
