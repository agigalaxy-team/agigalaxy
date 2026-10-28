package trustpackages

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Receipt(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := Parse("receipt", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		r, e := row(ctx, tx, "SELECT to_jsonb(p) FROM trust_package_permissions p WHERE id=$1 AND subject_id=$2", q["id"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return Object{"id": q["id"], "state": "absent"}, nil
		}
		return s.receiptRow(r), nil
	})
}
func (s *Service) Status(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := Parse("status", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		r, e := s.visibleRowWithin(ctx, tx, a.Actor, str(q, "id"))
		if e != nil {
			return nil, e
		}
		current, e := s.usableWithin(ctx, tx, r)
		if e != nil {
			return nil, e
		}
		return Object{"id": q["id"], "status": current["status"], "reason": current["reason"], "checkedAt": s.now(), "sourceAccessGranted": false, "currentRevocationChecked": true, "externalCopiesDeleted": false}, nil
	})
}
func (s *Service) Query(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := Parse("query", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		column := "subject_id"
		if q["role"] == "grantee" {
			column = "grantee_id"
		}
		records, e := rows(ctx, tx, "SELECT to_jsonb(p) FROM trust_package_permissions p WHERE "+column+"=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 51", a.SubjectID, q["after"])
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, r := range records[:min(len(records), 50)] {
			p, e := payload(r)
			if e != nil {
				return nil, e
			}
			current, e := s.usableWithin(ctx, tx, r)
			if e != nil {
				return nil, e
			}
			items = append(items, Object{"id": r["id"], "subjectId": r["subject_id"], "granteeId": r["grantee_id"], "source": p["source"], "sourceHash": p["sourceHash"], "audience": p["audience"], "expiresAt": p["expiresAt"], "status": current["status"], "reason": current["reason"]})
		}
		var next any
		if len(records) > 50 {
			next = records[49]["id"]
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.now(), "sourceAccessGranted": false}, nil
	})
}
func (s *Service) Sources(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := Parse("sources", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, control deviceauth.ControlAuthorization) (Object, error) {
		if number(q["expiresAt"]) <= s.now() || number(q["expiresAt"]) > s.now()+30*86400 {
			return nil, fail("trust_package_expiry_invalid")
		}
		items := []any{}
		for _, v := range array(q["selections"]) {
			selection := object(v)
			ref := object(selection["ref"])
			snapshot, e := func() (Object, error) {
				if e := s.localSource(ref); e != nil {
					return nil, e
				}
				var source Object
				var permission any
				if ref["kind"] == "ci-proof-v2" {
					if selection["mode"] != "reference" || selection["permissionId"] != nil {
						return nil, fail("trust_ci_reference_only", 403)
					}
					if e := sourceScope(control, ref); e != nil {
						return nil, e
					}
					if s.ReadSource == nil {
						return nil, fail("trust_source_adapter_unavailable", 503)
					}
					source, e = s.ReadSource(ctx, tx, &a.Actor, ref)
					if e != nil {
						return nil, e
					}
					if source["profile"] != "galaxy-ci-proof-v2-reference/1" || source["associatedSubjectId"] != a.SubjectID {
						return nil, fail("trust_ci_associated_subject_required", 403)
					}
					if number(q["expiresAt"]) > number(source["sourceExpiresAt"]) {
						return nil, fail("trust_ci_reference_expiry_exceeds_source")
					}
					return Object{"ref": source["ref"], "profile": source["profile"], "issuer": source["issuer"], "associatedSubjectId": source["associatedSubjectId"], "sourceHash": source["sourceHash"], "sourceSignatureHash": source["sourceSignatureHash"], "sourceExpiresAt": source["sourceExpiresAt"], "authority": source["authority"], "sourceState": source["sourceState"], "checkedAt": s.now(), "mode": "reference", "signatureEvidence": "not-provided", "referenceBasis": "associated-subject-reference", "limitations": source["limitations"]}, nil
				}
				if selection["permissionId"] != nil {
					r, e := s.visibleRowWithin(ctx, tx, a.Actor, str(selection, "permissionId"))
					if e != nil {
						return nil, e
					}
					p, e := payload(r)
					if e != nil {
						return nil, e
					}
					if p["grantee"] != a.SubjectID || !same(p["source"], ref) || !audienceAllows(object(p["audience"]), object(q["audience"])) || number(p["expiresAt"]) < number(q["expiresAt"]) {
						return nil, fail("trust_permission_scope_mismatch", 403)
					}
					current, e := s.usableWithin(ctx, tx, r)
					if e != nil {
						return nil, e
					}
					if current["status"] != "active" {
						code := str(current, "reason")
						if code == "" {
							code = "trust_permission_" + str(current, "status")
						}
						return nil, fail(code)
					}
					source = object(current["source"])
					permission = Object{"signed": r["signed"], "identity": r["identity"], "status": "active", "checkedAt": s.now()}
				} else {
					if e = sourceScope(control, ref); e != nil {
						return nil, e
					}
					source, e = s.ownSourceWithin(ctx, tx, a.Actor, ref)
					if e != nil {
						return nil, e
					}
				}
				if selection["mode"] != "reference" && permission == nil {
					return nil, fail("trust_reproduction_permission_required", 403)
				}
				basis := "own-authored-reference"
				if permission != nil {
					basis = "explicit-trust-permission"
				}
				snapshot := Object{"ref": source["ref"], "authorId": source["authorId"], "sourceHash": source["sourceHash"], "authority": source["authority"], "sourceState": source["sourceState"], "checkedAt": s.now(), "mode": selection["mode"], "signatureEvidence": "not-provided", "referenceBasis": basis, "limitations": source["limitations"]}
				if selection["mode"] == "copy" {
					snapshot["bodyText"], snapshot["permission"] = source["bodyText"], permission
				}
				return snapshot, nil
			}()
			if e != nil {
				var f *fault.Error
				if !errors.As(e, &f) {
					return nil, e
				}
				items = append(items, Object{"ref": ref, "state": "unavailable", "reason": f.Code})
			} else {
				items = append(items, Object{"ref": ref, "state": "available", "snapshot": snapshot})
			}
		}
		return Object{"items": items, "checkedAt": s.now(), "uploadedPackage": false, "modelCalls": 0}, nil
	})
}
