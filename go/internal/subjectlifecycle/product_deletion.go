package subjectlifecycle

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"sort"
	"time"
)

// ProductDeletion is used only after PrepareExecutionWithin verifies the exact
// approved owner intent under the closed maintenance table locks.
type TaskSnapshotRedactor func(*protocol.OrderedObject, map[string]bool, string) (*protocol.OrderedObject, error)
type TaskRedactors struct{ Task, Participation TaskSnapshotRedactor }
type ProductDeletion struct {
	Forum         *community.Service
	TaskSnapshots TaskRedactors
}

func recordErasure(ctx context.Context, tx pgx.Tx, table, key, subject string, hash any, info DeletionInfo, reason string) error {
	var original *string
	if value, ok := hash.(string); ok {
		original = &value
	}
	return RecordContentErasureWithin(ctx, tx, ContentErasure{Table: table, Key: key, SubjectID: subject, RequestID: info.RequestID, Reason: reason, OriginalHash: original, At: info.At, RetainedUntil: info.RetainedUntil})
}
func forumInfo(info DeletionInfo) community.DeletionInfo {
	id := info.RequestID
	return community.DeletionInfo{SubjectID: info.SubjectID, RequestID: &id, At: info.At, RetainedUntil: info.RetainedUntil}
}
func snapshot(raw any) (*protocol.OrderedObject, error) {
	data, e := protocol.DecodeOrdered([]byte(text(raw)))
	if e != nil {
		return nil, e
	}
	o, ok := data.(*protocol.OrderedObject)
	if !ok {
		return nil, errors.New("invalid retained task snapshot")
	}
	return o, nil
}
func redactTaskCopiesWithin(ctx context.Context, tx pgx.Tx, events []Object, info DeletionInfo, reason string, redactors TaskRedactors) (Object, error) {
	removed := map[string]bool{}
	tasks := map[string]bool{}
	for _, event := range events {
		removed[text(event["id"])] = true
		tasks[text(event["task_id"])] = true
	}
	if info.SubjectID != "" {
		own, e := rows(ctx, tx, `SELECT id FROM task_requests WHERE requester_id=$1`, info.SubjectID)
		if e != nil {
			return nil, e
		}
		for _, row := range own {
			tasks[text(row["id"])] = true
		}
	}
	ids := []string{}
	for id := range tasks {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) > 0 && (redactors.Task == nil || redactors.Participation == nil) {
		return nil, fault.New("lifecycle_task_redaction_unavailable", 503)
	}
	redacted := 0
	for _, id := range ids {
		requests, e := rows(ctx, tx, `SELECT id,requester_id,snapshot::text AS snapshot FROM task_requests WHERE id=$1 FOR UPDATE`, id)
		if e != nil {
			return nil, e
		}
		for _, row := range requests {
			before, e := snapshot(row["snapshot"])
			if e != nil {
				return nil, e
			}
			after, e := redactors.Task(before, removed, info.SubjectID)
			if e != nil {
				return nil, e
			}
			oldBytes, e := protocol.EncodeJS(before)
			if e != nil {
				return nil, e
			}
			newBytes, e := protocol.EncodeJS(after)
			if e != nil {
				return nil, e
			}
			if string(oldBytes) == string(newBytes) {
				continue
			}
			if info.SubjectID != "" && row["requester_id"] == info.SubjectID {
				if e := recordErasure(ctx, tx, "task_requests", text(row["id"]), info.SubjectID, identity.Digest(oldBytes), info, reason); e != nil {
					return nil, e
				}
			}
			if _, e = tx.Exec(ctx, `UPDATE task_requests SET snapshot=$2::jsonb WHERE id=$1`, row["id"], string(newBytes)); e != nil {
				return nil, e
			}
			redacted++
		}
		participations, e := rows(ctx, tx, `SELECT id,subject_id,snapshot::text AS snapshot FROM task_participations WHERE task_id=$1 FOR UPDATE`, id)
		if e != nil {
			return nil, e
		}
		for _, row := range participations {
			before, e := snapshot(row["snapshot"])
			if e != nil {
				return nil, e
			}
			after, e := redactors.Participation(before, removed, info.SubjectID)
			if e != nil {
				return nil, e
			}
			oldBytes, e := protocol.EncodeJS(before)
			if e != nil {
				return nil, e
			}
			newBytes, e := protocol.EncodeJS(after)
			if e != nil {
				return nil, e
			}
			if string(oldBytes) == string(newBytes) {
				continue
			}
			if info.SubjectID != "" && row["subject_id"] == info.SubjectID {
				if e := recordErasure(ctx, tx, "task_participations", text(row["id"]), info.SubjectID, identity.Digest(oldBytes), info, reason); e != nil {
					return nil, e
				}
			}
			if _, e = tx.Exec(ctx, `UPDATE task_participations SET snapshot=$2::jsonb WHERE id=$1`, row["id"], string(newBytes)); e != nil {
				return nil, e
			}
			redacted++
		}
	}
	for _, event := range events {
		if e := recordErasure(ctx, tx, "task_events", text(event["id"]), text(event["subject_id"]), event["payload_hash"], info, reason); e != nil {
			return nil, e
		}
	}
	return Object{"snapshotsRedacted": redacted, "eventReceipts": len(events)}, nil
}
func (p *ProductDeletion) PrepareWithin(ctx context.Context, tx pgx.Tx, info DeletionInfo) (Object, error) {
	if p == nil || p.Forum == nil {
		return nil, errors.New("forum deletion consumer unavailable")
	}
	subject, at := info.SubjectID, time.Unix(info.At, 0)
	work, e := tx.Exec(ctx, `UPDATE account_work_v1 SET state='deleted',revision=revision+1,data=NULL,deleted_at=$2,updated_at=$2 WHERE origin_subject_id=$1 AND state='stored'`, subject, at)
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `UPDATE account_work_scopes_v1 SET deleted_at=$2,deleted_reason='owner-deleted',deleted_by_kind='identity',deleted_by_subject_id=$1,deleted_request_id=$3 WHERE origin_subject_id=$1 AND deleted_at IS NULL`, subject, at, info.RequestID); e != nil {
		return nil, e
	}
	archives, e := tx.Exec(ctx, `INSERT INTO private_conversation_deletions_v1(archive_id,account_id,scope_id,origin_subject_id,reason,deleted_at) SELECT id,account_id,(selection->>'scopeId')::uuid,origin_subject_id,'owner-deleted',$2 FROM private_conversation_archives_v1 WHERE origin_subject_id=$1 ON CONFLICT(archive_id) DO NOTHING`, subject, at)
	if e != nil {
		return nil, e
	}
	for _, table := range []string{"forum_attachments_v1", "chat_attachments"} {
		if _, e = tx.Exec(ctx, `UPDATE `+table+` SET revoked_at=COALESCE(revoked_at,$2),purge_pending=true WHERE subject_id=$1 AND purged_at IS NULL`, subject, at); e != nil {
			return nil, e
		}
	}
	if _, e = tx.Exec(ctx, `UPDATE outcome_materials_v2 SET state=CASE WHEN state='erased' THEN state ELSE 'revoked' END,purge_pending=true WHERE purged_at IS NULL AND(subject_id=$1 OR author_id=$1)`, subject); e != nil {
		return nil, e
	}
	materials, e := rows(ctx, tx, `SELECT material_id,text_hash FROM task_materials_v1 WHERE subject_id=$1 AND body_text<>''`, subject)
	if e != nil {
		return nil, e
	}
	for _, row := range materials {
		if e := recordErasure(ctx, tx, "task_materials_v1", text(row["material_id"]), subject, row["text_hash"], info, "subject-deletion"); e != nil {
			return nil, e
		}
	}
	if _, e = tx.Exec(ctx, `UPDATE task_materials_v1 SET body_text='',erased_at=COALESCE(erased_at,$2) WHERE subject_id=$1`, subject, at); e != nil {
		return nil, e
	}
	if _, e = p.Forum.PrepareDeletionWithin(ctx, tx, forumInfo(info)); e != nil {
		return nil, e
	}
	for _, sql := range []string{`UPDATE hub_heads_v2 SET state='suspended' WHERE owner_id=$1`, `UPDATE hub_intake_v2 SET state='closed' WHERE subject_id=$1`, `UPDATE hub_memberships_v2 SET state='exited' WHERE subject_id=$1 AND state IN('active','invited')`, `UPDATE hub_peering_agreements_v2 SET state='exited' WHERE subject_id=$1`, `UPDATE task_comments_v2 SET state='retracted',account_id=NULL,review_event_id=NULL WHERE subject_id=$1`} {
		if _, e = tx.Exec(ctx, sql, subject); e != nil {
			return nil, e
		}
	}
	if _, e = tx.Exec(ctx, `UPDATE hub_peering_grants_v2 SET revoked_at=COALESCE(revoked_at,$2) WHERE subject_id=$1`, subject, info.At); e != nil {
		return nil, e
	}
	events, e := rows(ctx, tx, `SELECT id,task_id,subject_id,payload_hash FROM task_events WHERE subject_id=$1`, subject)
	if e != nil {
		return nil, e
	}
	out, e := redactTaskCopiesWithin(ctx, tx, events, info, "subject-deletion", p.TaskSnapshots)
	if e != nil {
		return nil, e
	}
	for _, table := range []string{"case_events", "verification_events"} {
		sql := `SELECT id,payload_hash FROM case_events WHERE subject_id=$1`
		if table == "verification_events" {
			sql = `SELECT e.operation_id AS id,e.payload_hash FROM verification_events e JOIN verification_objects o ON o.id=e.object_id WHERE o.subject_id=$1`
		}
		events, e := rows(ctx, tx, sql, subject)
		if e != nil {
			return nil, e
		}
		for _, row := range events {
			if e := recordErasure(ctx, tx, table, text(row["id"]), subject, row["payload_hash"], info, "subject-deletion"); e != nil {
				return nil, e
			}
		}
	}
	cases, e := rows(ctx, tx, `SELECT id,local_ref,source_ref FROM cases WHERE subject_id=$1`, subject)
	if e != nil {
		return nil, e
	}
	for _, row := range cases {
		erased := "erased:" + text(row["id"])
		if row["local_ref"] == erased && row["source_ref"] == erased {
			continue
		}
		raw, e := protocol.EncodeJS(fieldObject("localRef", row["local_ref"], "sourceRef", row["source_ref"]))
		if e != nil {
			return nil, e
		}
		if e = recordErasure(ctx, tx, "cases", text(row["id"]), subject, identity.Digest(raw), info, "subject-deletion"); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE cases SET local_ref=$2,source_ref=$2 WHERE id=$1`, row["id"], erased); e != nil {
			return nil, e
		}
	}
	for _, sql := range []string{`UPDATE device_authorizations SET status='revoked',revoked_at=COALESCE(revoked_at,$2) WHERE subject_id=$1`, `UPDATE projects_v2 SET state='archived',updated_at=$2 WHERE owner_id=$1`, `UPDATE recruitment_opportunities SET state=CASE WHEN project_id IN(SELECT id FROM projects_v2 WHERE owner_id=$1) THEN 'closed' ELSE 'paused' END,updated_at=$2 WHERE project_id IN(SELECT id FROM projects_v2 WHERE owner_id=$1) OR publisher_id=$1 OR contact_subject_id=$1`, `UPDATE project_roles_v2 SET state='revoked',updated_at=$2 WHERE subject_id=$1`, `UPDATE project_transfers_v2 SET state='cancelled',updated_at=$2 WHERE state='offered' AND(from_subject_id=$1 OR to_subject_id=$1)`, `UPDATE contacts_v2 SET state=CASE WHEN initiator_id=$1 THEN 'withdrawn' ELSE 'declined' END,updated_at=$2 WHERE state='sent' AND(initiator_id=$1 OR recipient_id=$1)`, `UPDATE personal_summary_preferences SET enabled=false,updated_at=$2 WHERE subject_id=$1`, `UPDATE choice_snapshot_preferences SET enabled=false,snapshot_ids='[]',revision=revision+1,updated_at=$2 WHERE subject_id=$1`, `UPDATE room_shared_summaries SET content='{}'::jsonb,source_facts='[]'::jsonb,state='retracted',retracted_at=COALESCE(retracted_at,$2) WHERE subject_id=$1`, `UPDATE community_interactions SET invalidated_at=COALESCE(invalidated_at,$2) WHERE counterparty_id=$1 OR source_id IN(SELECT id FROM task_events WHERE subject_id=$1)`} {
		if _, e = tx.Exec(ctx, sql, subject, at); e != nil {
			return nil, e
		}
	}
	for _, sql := range []string{`UPDATE recovery_authorizations SET status='replaced' WHERE subject_id=$1 AND status='active'`, `UPDATE identity_control_operations SET state='canceled' WHERE subject_id=$1 AND state='requested'`, `UPDATE verification_objects SET state='revoked' WHERE subject_id=$1`, `UPDATE experience_objects SET state='revoked' WHERE subject_id=$1`, `UPDATE personal_summary_versions SET content='{}'::jsonb,state='deleted' WHERE subject_id=$1`, `UPDATE choice_snapshot_versions SET content='{}',dependencies='[]',state='deleted' WHERE subject_id=$1`} {
		if _, e = tx.Exec(ctx, sql, subject); e != nil {
			return nil, e
		}
	}
	out["originWorkBodiesErased"] = work.RowsAffected()
	out["originArchiveDeletionMarkers"] = archives.RowsAffected()
	out["originUploadReceipts"] = "retained-to-prevent-replay"
	out["forumAttachmentObjects"] = "delegated-erasure-required"
	return out, nil
}
func (p *ProductDeletion) MinimizeWithin(ctx context.Context, tx pgx.Tx, info DeletionInfo) (Object, error) {
	if p == nil || p.Forum == nil {
		return nil, errors.New("forum deletion consumer unavailable")
	}
	out, e := p.Forum.MinimizeDeletionWithin(ctx, tx, forumInfo(info))
	if e != nil {
		return nil, e
	}
	subject, at := info.SubjectID, time.Unix(info.At, 0)
	if _, e = tx.Exec(ctx, `UPDATE identity_groups_v2 SET source_erased_at=COALESCE(source_erased_at,$2) WHERE member_ids ? $1`, subject, at); e != nil {
		return nil, e
	}
	groups, e := rows(ctx, tx, `SELECT id,payload_hash FROM identity_group_operations_v2 WHERE subject_id=$1 AND payload_text<>''`, subject)
	if e != nil {
		return nil, e
	}
	for _, row := range groups {
		if e := recordErasure(ctx, tx, "identity_group_operations_v2", text(row["id"]), subject, row["payload_hash"], info, "subject-deletion"); e != nil {
			return nil, e
		}
	}
	if len(groups) > 0 {
		if _, e = tx.Exec(ctx, `UPDATE identity_group_operations_v2 SET payload_text='',erased_at=COALESCE(erased_at,$2) WHERE subject_id=$1`, subject, at); e != nil {
			return nil, e
		}
	}
	out["identity_group_operations_v2"] = len(groups)
	for _, table := range []string{"target_governance_events_v2", "hub_events_v2", "hub_peering_events_v2", "qualification_permission_request_events", "case_events", "task_events", "capsule_events", "capsule_uses", "capsule_uses_v2", "capsule_permissions", "qualification_calculation_grants", "context_grants_v2", "context_events_v2", "task_comment_events_v2", "comment_governance_events_v2"} {
		bodyPresent := `payload_text<>''`
		if table == "case_events" {
			// Approved repair: old partial erasures could leave the JSONB copy
			// after clearing payload_text. IDs/hashes and other authors stay.
			bodyPresent = `(payload_text<>'' OR payload<>'{}'::jsonb)`
		}
		records, e := rows(ctx, tx, `SELECT id,payload_hash FROM `+table+` WHERE subject_id=$1 AND `+bodyPresent, subject)
		if e != nil {
			return nil, e
		}
		ids := []string{}
		for _, row := range records {
			ids = append(ids, text(row["id"]))
			if e := recordErasure(ctx, tx, table, text(row["id"]), subject, row["payload_hash"], info, "subject-deletion"); e != nil {
				return nil, e
			}
		}
		if len(ids) > 0 {
			extra := ""
			if table == "capsule_permissions" || table == "qualification_calculation_grants" {
				extra = ",revoke_payload_text=CASE WHEN revoke_payload_text IS NULL THEN NULL ELSE '' END"
			}
			if table == "case_events" {
				extra = ",payload='{}'::jsonb"
			}
			if _, e = tx.Exec(ctx, `UPDATE `+table+` SET payload_text=''`+extra+` WHERE id=ANY($1::uuid[])`, ids); e != nil {
				return nil, e
			}
			if table == "context_grants_v2" {
				if _, e = tx.Exec(ctx, `UPDATE context_grants_v2 SET erased_at=COALESCE(erased_at,$2) WHERE id=ANY($1::uuid[])`, ids, at); e != nil {
					return nil, e
				}
			}
			if contains([]string{"target_governance_events_v2", "task_comment_events_v2", "comment_governance_events_v2"}, table) {
				extra := ""
				if table == "task_comment_events_v2" {
					extra = ",text_fingerprint=NULL,link_fingerprints='[]'"
				}
				if _, e = tx.Exec(ctx, `UPDATE `+table+` SET erased_at=COALESCE(erased_at,$2)`+extra+` WHERE id=ANY($1::uuid[])`, ids, at); e != nil {
					return nil, e
				}
			}
		}
		out[table] = len(records)
	}
	verification, e := rows(ctx, tx, `SELECT e.operation_id,e.payload_hash FROM verification_events e JOIN verification_objects o ON o.id=e.object_id WHERE o.subject_id=$1 AND e.payload_text<>''`, subject)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, row := range verification {
		ids = append(ids, text(row["operation_id"]))
		if e := recordErasure(ctx, tx, "verification_events", text(row["operation_id"]), subject, row["payload_hash"], info, "subject-deletion"); e != nil {
			return nil, e
		}
	}
	if len(ids) > 0 {
		if _, e = tx.Exec(ctx, `UPDATE verification_events SET payload_text='',payload='{}'::jsonb,context='{}'::jsonb WHERE operation_id=ANY($1::uuid[])`, ids); e != nil {
			return nil, e
		}
	}
	out["verification_events"] = len(verification)
	for _, table := range []string{"project_events_v2", "contact_events_v2", "experience_events", "recruitment_events", "configuration_events"} {
		predicate := "subject_id=$1"
		if table == "experience_events" {
			predicate = "object_id IN(SELECT id FROM experience_objects WHERE subject_id=$1)"
		}
		retained, e := rows(ctx, tx, `SELECT operation_id,payload_hash FROM `+table+` WHERE `+predicate+` AND payload_text<>''`, subject)
		if e != nil {
			return nil, e
		}
		ids := []string{}
		for _, row := range retained {
			ids = append(ids, text(row["operation_id"]))
			if e := recordErasure(ctx, tx, table, text(row["operation_id"]), subject, row["payload_hash"], info, "subject-deletion"); e != nil {
				return nil, e
			}
		}
		if len(ids) > 0 {
			extra := ""
			if table == "experience_events" {
				extra = ",context='{}'::jsonb"
			}
			if _, e = tx.Exec(ctx, `UPDATE `+table+` SET payload_text=''`+extra+` WHERE operation_id=ANY($1::uuid[])`, ids); e != nil {
				return nil, e
			}
		}
		out[table] = len(retained)
	}
	return out, nil
}
