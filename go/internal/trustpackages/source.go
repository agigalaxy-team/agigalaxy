package trustpackages

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

// Author projections are narrowly supplied by their owning source domains only
// after the permission service establishes a current exact signed author grant.
type SourceReader struct {
	Endpoint           string
	Cases              *cases.Service
	Records            *verificationrecords.Service
	CI                 *civ2.Service
	ReadCaseAsAuthor   func(context.Context, pgx.Tx, string, string, string) (Object, error)
	ReadRecordAsAuthor func(context.Context, pgx.Tx, string, Object) (Object, error)
	Now                func() time.Time
}

func (r *SourceReader) now() int64 {
	if r.Now != nil {
		return r.Now().Unix()
	}
	return time.Now().Unix()
}
func (r *SourceReader) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref Object) (Object, error) {
	return r.read(ctx, tx, a, "", ref)
}
func (r *SourceReader) ReadAuthorWithin(ctx context.Context, tx pgx.Tx, author string, ref Object) (Object, error) {
	return r.read(ctx, tx, nil, author, ref)
}
func (r *SourceReader) read(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, grantAuthor string, ref Object) (Object, error) {
	var record, view Object
	author, state, authority := "", "current", "participant-reported"
	var e error
	switch ref["kind"] {
	case "ci-proof-v2":
		if grantAuthor != "" {
			return nil, fail("trust_issuer_source_profile_unavailable")
		}
		return r.ciSource(ctx, tx, a, ref)
	case "case-event":
		if ref["caseId"] == nil {
			return nil, fail("trust_case_id_required", 422)
		}
		record, e = row(ctx, tx, "SELECT to_jsonb(e) FROM case_events e WHERE id=$1 AND case_id=$2 AND version=$3", ref["id"], ref["caseId"], ref["version"])
		if e != nil {
			return nil, e
		}
		if str(record, "payload_text") == "" {
			return nil, fail("trust_source_unavailable", 404)
		}
		if grantAuthor != "" {
			if r.ReadCaseAsAuthor == nil {
				return nil, fail("trust_author_case_reader_unavailable", 503)
			}
			view, e = r.ReadCaseAsAuthor(ctx, tx, grantAuthor, str(ref, "caseId"), str(ref, "taskId"))
		} else {
			if r.Cases == nil || a == nil {
				return nil, fail("trust_case_reader_unavailable", 503)
			}
			view, e = r.Cases.ReadV2Within(ctx, tx, *a, str(ref, "caseId"), str(ref, "taskId"))
		}
		if e != nil {
			return nil, e
		}
		visible := false
		for _, v := range array(view["events"]) {
			event := object(v)
			if event["eventId"] == ref["id"] && number(event["caseVersion"]) == number(ref["version"]) {
				visible = true
				break
			}
		}
		if !visible {
			return nil, fail("trust_source_unavailable", 404)
		}
		p := object(record["payload"])
		if p["actorId"] != record["subject_id"] {
			return nil, fail("trust_legacy_author_unknown")
		}
		author = str(record, "subject_id")
		kind := str(p, "kind")
		field := ""
		if strings.HasPrefix(kind, "attempt-") {
			field = "attempts"
		} else if kind == "intervention" {
			field = "interventions"
		} else if kind == "result-recorded" {
			field = "results"
		}
		var selected Object
		for _, v := range array(view[field]) {
			if object(v)["eventId"] == ref["id"] {
				selected = object(v)
				break
			}
		}
		if selected != nil {
			for _, v := range array(view[field]) {
				f := object(v)
				if f["id"] == selected["id"] && number(f["version"]) > number(selected["version"]) {
					state = "superseded"
				}
			}
		}
		if kind == "case-created" || kind == "case-scope-revised" {
			all := array(view["scopes"])
			if len(all) == 0 || object(all[len(all)-1])["eventId"] != ref["id"] {
				state = "superseded"
			}
		}
		if kind == "resolution-recorded" {
			all := array(view["resolutions"])
			if len(all) == 0 || object(all[len(all)-1])["eventId"] != ref["id"] {
				state = "superseded"
			}
		}
	case "evidence", "verification":
		objectRow, e := row(ctx, tx, "SELECT to_jsonb(o) FROM verification_objects o WHERE id=$1 AND object_type=$2", ref["id"], ref["kind"])
		if e != nil {
			return nil, e
		}
		if objectRow == nil {
			return nil, fail("trust_source_unavailable", 404)
		}
		record, e = row(ctx, tx, "SELECT to_jsonb(e) FROM verification_events e WHERE object_id=$1 AND version=$2", ref["id"], ref["version"])
		if e != nil {
			return nil, e
		}
		if str(record, "payload_text") == "" || ref["caseId"] != nil && ref["caseId"] != objectRow["case_id"] {
			return nil, fail("trust_source_unavailable", 404)
		}
		input := Object{"type": ref["kind"], "id": ref["id"], "version": ref["version"]}
		if grantAuthor != "" {
			if r.ReadRecordAsAuthor == nil {
				return nil, fail("trust_author_record_reader_unavailable", 503)
			}
			view, e = r.ReadRecordAsAuthor(ctx, tx, grantAuthor, input)
		} else {
			if r.Records == nil {
				return nil, fail("trust_record_reader_unavailable", 503)
			}
			view, e = r.Records.ReadWithin(ctx, tx, a, input)
		}
		if e != nil {
			return nil, e
		}
		if view["record"] == nil {
			return nil, fail("trust_source_unavailable", 404)
		}
		author = str(objectRow, "subject_id")
		state = str(view, "referenceStatus")
		if ref["kind"] == "verification" {
			authority = "verification-record"
		} else if object(record["payload"])["evidenceType"] == "self-assertion" {
			authority = "self-asserted"
		}
	default:
		return nil, fail("trust_issuer_source_profile_unavailable")
	}
	if identity.Digest([]byte(str(record, "payload_text"))) != record["payload_hash"] {
		return nil, fail("stored_integrity_mismatch", 500)
	}
	if state != "current" && state != "superseded" {
		return nil, fail("trust_source_not_currently_usable")
	}
	var pending bool
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased'))", author).Scan(&pending); e != nil {
		return nil, e
	}
	if pending {
		return nil, fail("trust_source_deletion_pending")
	}
	p := object(record["payload"])
	dependencies := []any{}
	for _, key := range []string{"sourceRefs", "deliverableRefs", "evidenceRefs", "verificationRefs", "resultRefs"} {
		dependencies = append(dependencies, array(p[key])...)
	}
	for _, key := range []string{"origin", "target"} {
		if p[key] != nil {
			dependencies = append(dependencies, p[key])
		}
	}
	owned := true
	for _, v := range dependencies {
		dep := object(v)
		kind := dep["kind"]
		found := false
		if ref["kind"] == "case-event" && (kind == "attempt" || kind == "intervention" || kind == "result") {
			for _, v := range array(view["events"]) {
				event := object(v)
				if event["eventId"] == dep["id"] && event["actorId"] == author {
					found = true
					break
				}
			}
		}
		if !found {
			owned = false
		}
	}
	eligible := owned && p["participationId"] == nil && len(jstext.From(str(record, "payload_text"))) <= 48000
	limitations := []any{"Source content is an authored report; its signature does not prove truth, success or capability.", "Original Consent JWS is not copied: its other recipients and bindings are outside this source-body permission."}
	var limitation any
	if !eligible {
		limitation = "linked-source-reproduction-permissions-not-yet-provided"
		limitations = append(limitations, "This source has linked materials; the ordinary license profile only supports a reference.")
	}
	return Object{"ref": ref, "authorId": author, "sourceHash": record["payload_hash"], "bodyText": record["payload_text"], "sourceState": state, "authority": authority, "copyEligible": eligible, "copyLimitation": limitation, "limitations": limitations}, nil
}
func (r *SourceReader) ciSource(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref Object) (Object, error) {
	if number(ref["version"]) != 1 || ref["caseId"] != nil || ref["taskId"] != nil {
		return nil, fail("trust_ci_reference_locator_invalid", 422)
	}
	if r.CI == nil || r.CI.Signer == nil {
		return nil, fail("trust_issuer_source_profile_unavailable")
	}
	record, e := row(ctx, tx, "SELECT jsonb_build_object('subject_id',subject_id,'payload_text',payload_text,'payload_hash',payload_hash,'signed',signed) FROM ci_proofs_v2 WHERE id=$1", ref["id"])
	if e != nil {
		return nil, e
	}
	if record == nil || a == nil || record["subject_id"] != a.SubjectID {
		return nil, fail("trust_ci_associated_subject_required", 403)
	}
	_, signedExpires, e := r.CI.Signer.VerifyProof(ctx, str(record, "signed"), r.now())
	if e != nil {
		return nil, fail("trust_ci_signature_unavailable")
	}
	parts := strings.Split(str(record, "signed"), ".")
	var envelope Object
	if len(parts) != 3 {
		return nil, fail("trust_ci_signature_unavailable")
	}
	raw, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil || json.Unmarshal(raw, &envelope) != nil {
		return nil, fail("trust_ci_signature_unavailable")
	}
	if envelope["jti"] != ref["id"] {
		return nil, fail("trust_ci_reference_profile_mismatch")
	}
	view, e := r.CI.ProofWithin(ctx, tx, a, str(ref, "id"))
	if e != nil {
		return nil, e
	}
	data, e := protocol.EncodeJS(view["data"])
	if e != nil {
		return nil, e
	}
	var fields Object
	if json.Unmarshal(data, &fields) != nil {
		return nil, fail("trust_ci_reference_profile_mismatch")
	}
	if number(fields["version"]) != 2 || fields["sourceProfile"] != "facts-v2" || fields["id"] != ref["id"] || fields["subject"] != record["subject_id"] || fields["issuer"] != ref["endpoint"] || ref["endpoint"] != r.CI.Endpoint {
		return nil, fail("trust_ci_reference_profile_mismatch")
	}
	if record["signed"] != view["signed"] || record["payload_text"] != string(data) || identity.Digest([]byte(str(record, "payload_text"))) != record["payload_hash"] {
		return nil, fail("stored_integrity_mismatch", 500)
	}
	if !integer(fields["expiresAt"], 0) || signedExpires < 0 || signedExpires > 9007199254740991 {
		return nil, fail("trust_ci_reference_expiry_invalid", 500)
	}
	until := min(signedExpires, number(fields["expiresAt"]))
	if until <= r.now() {
		return nil, fail("trust_source_not_currently_usable")
	}
	return Object{"ref": ref, "profile": "galaxy-ci-proof-v2-reference/1", "issuer": fields["issuer"], "associatedSubjectId": record["subject_id"], "sourceHash": record["payload_hash"], "sourceSignatureHash": identity.Digest([]byte(str(view, "signed"))), "sourceExpiresAt": until, "sourceState": "current", "authority": "ci-observation", "copyEligible": false, "limitations": []any{"The issuer is the CI observation service; the associated subject is not its issuer or a reproduction license holder.", "Only exact publication coordinates and hashes are included; original CI Proof text and signed bytes are not copied.", "A CI observation does not certify task success, capability, source ownership or independent execution.", "Source availability and authorization were checked only at the recorded observation; offline reading grants no current access."}}, nil
}
