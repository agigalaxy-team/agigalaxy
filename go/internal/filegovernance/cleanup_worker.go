package filegovernance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"regexp"
	"time"
)

func (s *Service) approver(ctx context.Context, tx pgx.Tx, plan Object) error {
	if str(plan, "approved_by") == "" || plan["approved_at"] == nil {
		return fail("operations_file_cleanup_approval_required", 403)
	}
	if s.StoredAuthority == nil {
		return fail("operations_authorization_unavailable", 503)
	}
	person, e := s.StoredAuthority.PersonWithin(ctx, tx, str(plan, "approved_by"), false)
	if e != nil {
		return e
	}
	if person.ID != str(plan, "approved_by") || person.Endpoint != s.Endpoint {
		return fail("business_admin_denied", 403)
	}
	if !has(person.Permissions, "files.cleanup.approve") {
		return fail("operations_permission_denied", 403)
	}
	return nil
}
func (s *Service) finish(ctx context.Context, tx pgx.Tx, id string) error {
	items, e := rows(ctx, tx, "SELECT to_jsonb(q) FROM (SELECT state,attempt_count FROM operations_file_cleanup_items_v1 WHERE plan_id=$1)q", id)
	if e != nil {
		return e
	}
	unfinished, unknown := false, false
	for _, item := range items {
		state := str(item, "state")
		unfinished = unfinished || state == "pending" || state == "removing" || state == "result-unknown" && num(item, "attempt_count") < 3
		unknown = unknown || state == "result-unknown"
	}
	state := "completed"
	if unfinished {
		state = "running"
	} else if unknown {
		state = "attention"
	}
	_, e = tx.Exec(ctx, "UPDATE operations_file_cleanup_plans_v1 SET state=$2,revision=revision+1,completed_at=CASE WHEN $2 IN('completed','attention') THEN $3::timestamptz ELSE NULL END WHERE id=$1 AND state IN('queued','running')", id, state, s.stamp())
	return e
}

var cleanupError = regexp.MustCompile(`^[a-z][a-z0-9_]{0,100}$`)

func (s *Service) ProcessApproved(ctx context.Context, limit int) (Object, error) {
	if limit < 1 || limit > 20 {
		return nil, invalid()
	}
	processed := 0
	removals := &objectremoval.Service{Pool: s.Pool, Endpoint: s.Endpoint, Now: s.Now}
	for n := 0; n < limit; n++ {
		var removalClaim *objectremoval.Reservation
		claimed, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			plan, e := row(ctx, tx, `SELECT to_jsonb(p) FROM operations_file_cleanup_plans_v1 p WHERE endpoint=$1 AND state IN('queued','running') AND EXISTS(SELECT 1 FROM operations_file_cleanup_items_v1 i WHERE i.plan_id=p.id AND (i.state='pending' OR i.state IN('removing','result-unknown') AND i.attempt_count<3 AND i.next_attempt_at<=$2)) ORDER BY created_at,id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, s.Endpoint, s.stamp())
			if e != nil || plan == nil {
				return nil, e
			}
			item, e := row(ctx, tx, "SELECT to_jsonb(i) FROM operations_file_cleanup_items_v1 i WHERE plan_id=$1 AND (state='pending' OR state IN('removing','result-unknown') AND attempt_count<3 AND next_attempt_at<=$2) ORDER BY position LIMIT 1 FOR UPDATE", plan["id"], s.stamp())
			if e != nil {
				return nil, e
			}
			if item == nil {
				return nil, nil
			}

			metadata, metadataError := s.fileRow(ctx, tx, str(item, "kind"), str(item, "file_id"), true)
			if metadataError != nil && fault.Status(metadataError) != 404 {
				return nil, metadataError
			}
			if metadata != nil && metadata["purged_at"] == nil {
				legacy := str(item, "state") != "pending" || num(item, "attempt_count") > 0 || str(metadata, "last_error") == "attachment_cleanup_failed"
				removalClaim, e = removals.ReserveWithin(ctx, tx, objectremoval.Descriptor{Domain: str(item, "kind"), ObjectID: str(metadata, "id"), StorageKey: str(metadata, "storage_key"), KeyID: str(metadata, "encryption_key_id"), ByteSize: num(metadata, "byte_size"), SHA256: str(metadata, "sha256")}, legacy)
				if e != nil {
					return nil, e
				}
			}
			attempt := uuidNew()
			if _, e = tx.Exec(ctx, "UPDATE operations_file_cleanup_items_v1 SET state='removing',attempt_count=attempt_count+1,attempt_id=$3,attempted_at=$4,next_attempt_at=$5 WHERE plan_id=$1 AND position=$2", plan["id"], item["position"], attempt, s.stamp(), s.stamp().Add(120*time.Second)); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE operations_file_cleanup_plans_v1 SET state='running',revision=revision+1 WHERE id=$1", plan["id"]); e != nil {
				return nil, e
			}
			return Object{"planId": plan["id"], "position": item["position"], "attempt": attempt}, nil
		})
		if e != nil {
			return nil, e
		}
		if claimed == nil {
			break
		}
		var dispatchError error
		_, attemptError := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			plan, e := s.planRow(ctx, tx, str(claimed, "planId"), true)
			if e != nil {
				return nil, e
			}
			item, e := row(ctx, tx, "SELECT to_jsonb(i) FROM operations_file_cleanup_items_v1 i WHERE plan_id=$1 AND position=$2 FOR UPDATE", plan["id"], claimed["position"])
			if e != nil {
				return nil, e
			}
			if !has([]string{"queued", "running"}, str(plan, "state")) || item == nil || item["attempt_id"] != claimed["attempt"] || str(item, "state") != "removing" {
				return Object{}, nil
			}
			if e = s.approver(ctx, tx, plan); e != nil {
				return nil, e
			}
			r, e := s.scopedRow(ctx, tx, str(item, "kind"), str(item, "file_id"), true)
			if e != nil && fault.Status(e) != 404 {
				return nil, e
			}
			skip := ""
			if r == nil {
				skip = "file-unavailable"
			} else if r["purged_at"] != nil {
				skip = "already-removed"
			} else {
				facts, e := s.facts(ctx, tx, str(item, "kind"), r, false, str(plan, "id"))
				if e != nil {
					return nil, e
				}
				equal, e := same(facts["source"], item["reference_state"])
				if e != nil {
					return nil, e
				}
				if ProcessingVersion(r) != str(item, "expected_version") {
					skip = "file-changed"
				} else if !equal {
					skip = "references-changed"
				} else if !truth(obj(facts, "eligibility"), "eligible") || obj(facts, "eligibility")["reason"] != item["reason"] {
					skip = "eligibility-changed"
				}
			}
			if skip != "" {
				state := "skipped"
				var removed any
				if skip == "already-removed" {
					state = "removed"
					removed = true
				}
				if _, e = tx.Exec(ctx, "UPDATE operations_file_cleanup_items_v1 SET state=$3,result_code=$4,object_removed=$5,completed_at=$6,next_attempt_at=NULL WHERE plan_id=$1 AND position=$2", plan["id"], item["position"], state, skip, removed, s.stamp()); e != nil {
					return nil, e
				}
				return Object{}, s.finish(ctx, tx, str(plan, "id"))
			}
			adapter, e := s.adapter(str(item, "kind"), true)
			if e != nil {
				return nil, e
			}
			store, ok := adapter.Store.(cleanupStore)
			if !ok {
				return nil, fail("attachment_service_unavailable", 503)
			}
			if e = s.approver(ctx, tx, plan); e != nil {
				return nil, e
			}

			descriptor := objectremoval.Descriptor{Domain: str(item, "kind"), ObjectID: str(r, "id"), StorageKey: str(r, "storage_key"), KeyID: str(r, "encryption_key_id"), ByteSize: num(r, "byte_size"), SHA256: str(r, "sha256")}
			observed, storageError := removals.ResolveWithin(ctx, tx, store, descriptor, removalClaim)
			if storageError != nil {
				if observed.State == "" {
					return nil, storageError
				}
				dispatchError = storageError
				return Object{}, nil
			}
			if !observed.ObjectRemoved {
				dispatchError = fail("operations_file_cleanup_result_unknown", 503)
				return Object{}, nil
			}
			if e = s.approver(ctx, tx, plan); e != nil {
				return nil, e
			}
			name, e := table(str(item, "kind"))
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE "+name+" SET state='erased',name='',media_type='',purge_pending=false,purged_at=$2 WHERE id=$1", r["id"], s.stamp()); e != nil {
				return nil, e
			}
			code := "object-already-absent"
			if observed.DispatchIssued {
				code = "object-removed"
			}
			if _, e = tx.Exec(ctx, "UPDATE operations_file_cleanup_items_v1 SET state='removed',result_code=$3,object_removed=true,completed_at=$4,next_attempt_at=NULL WHERE plan_id=$1 AND position=$2", plan["id"], item["position"], code, s.stamp()); e != nil {
				return nil, e
			}
			return Object{}, s.finish(ctx, tx, str(plan, "id"))
		})

		if attemptError == nil {
			attemptError = dispatchError
		}
		if _, markError := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
			code := ""
			if attemptError != nil {
				code = fault.Code(attemptError)
			}
			return removals.NotDispatchedWithin(ctx, tx, removalClaim, code)
		}); markError != nil && attemptError == nil {
			attemptError = markError
		}
		if attemptError != nil {
			code := fault.Code(attemptError)
			if code == "internal_error" || !cleanupError.MatchString(code) {
				code = "operations_file_cleanup_unavailable"
			}
			if s.Diagnostic != nil {
				func() {
					defer func() { _ = recover() }()
					s.Diagnostic(Object{"event": "file_cleanup_deferred", "stage": "approved-file-cleanup", "resourceId": claimed["planId"], "error": code})
				}()
			}
			_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
				plan, e := s.planRow(ctx, tx, str(claimed, "planId"), true)
				if e != nil {
					return nil, e
				}
				if str(plan, "state") == "cancelled" {
					return Object{}, nil
				}
				if _, e = tx.Exec(ctx, "UPDATE operations_file_cleanup_items_v1 SET state='result-unknown',result_code=$4,object_removed=NULL,next_attempt_at=CASE WHEN attempt_count<3 THEN $5::timestamptz ELSE NULL END WHERE plan_id=$1 AND position=$2 AND attempt_id=$3 AND state='removing'", claimed["planId"], claimed["position"], claimed["attempt"], code, s.stamp().Add(30*time.Second)); e != nil {
					return nil, e
				}
				return Object{}, s.finish(ctx, tx, str(plan, "id"))
			})
			if e != nil {
				return nil, e
			}
		}
		processed++
	}
	return Object{"processed": processed, "physicalBlocksReleased": nil}, nil
}
