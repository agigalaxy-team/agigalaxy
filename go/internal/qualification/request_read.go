package qualification

import (
	"context"
	"encoding/json"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func timestamp(v any) (time.Time, error) { return time.Parse(time.RFC3339Nano, text(v)) }
func isoTimestamp(v any) (string, error) {
	t, e := timestamp(v)
	return t.UTC().Format("2006-01-02T15:04:05.000Z"), e
}
func (s *Service) requestGrant(ctx context.Context, tx pgx.Tx, event Object) (deviceauth.ConsentIntent, error) {
	return s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(event, "consent_id"), SubjectID: str(event, "subject_id"), ObjectID: str(event, "id"), Action: "qualification.request", Recipient: s.Endpoint, PayloadJSON: str(event, "payload_text")})
}
func (s *Service) requestRoot(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, row Object) (Object, error) {
	event, e := readRow(ctx, tx, "SELECT to_jsonb(e) FROM qualification_permission_request_events e WHERE id=$1", row["root_event_id"])
	if e != nil {
		return nil, e
	}
	if event == nil || str(event, "payload_text") == "" {
		return nil, fail("qualification_request_source_erased", 404)
	}
	g, e := s.requestGrant(ctx, tx, event)
	if e != nil {
		return nil, e
	}
	if !s.Assistance.LegacySourceVisible(g, a.SubjectID) {
		return nil, fail("qualification_request_unavailable", 404)
	}
	return ParseRequestEvent([]byte(str(event, "payload_text")))
}
func (s *Service) ReadRequestWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, input Object) (Object, error) {
	if s == nil || s.Devices == nil || s.Assistance == nil {
		return nil, fail("qualification_unavailable", 503)
	}
	if !queryClosed(input, []string{"requestId"}, nil) || !uuidPattern.MatchString(str(input, "requestId")) {
		return requestInvalid()
	}
	row, e := readRow(ctx, tx, "SELECT to_jsonb(r) FROM qualification_permission_requests r WHERE id=$1 AND (subject_id=$2 OR source_author_id=$2) FOR SHARE", input["requestId"], a.SubjectID)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, fail("qualification_request_unavailable", 404)
	}
	role := "source-author"
	if row["subject_id"] == a.SubjectID {
		role = "candidate"
	}
	base := Object{"requestId": row["id"], "version": row["version"], "state": row["state"], "role": role, "permissionGranted": false}
	expires, e := timestamp(row["expires_at"])
	if e != nil {
		return nil, e
	}
	if expires.UnixMilli() <= s.now()*1000 {
		base["state"], base["expiresAt"] = "expired", expires.UTC().Format("2006-01-02T15:04:05.000Z")
		return base, nil
	}
	root, e := s.requestRoot(ctx, tx, a, row)
	if e != nil {
		if !unavailable(e) {
			return nil, e
		}
		base["state"] = "request-source-unavailable"
		return base, nil
	}
	recipient, e := readRow(ctx, tx, "SELECT jsonb_build_object('requester_id',requester_id) FROM task_requests WHERE id=$1", row["task_id"])
	if e != nil {
		return nil, e
	}
	materials := []any{}
	available := true
	for _, v := range array(root["sourceRefs"]) {
		ref := object(v)
		material, e := func() (Object, error) {
			source, e := s.calculationSourceWithin(ctx, tx, ref)
			if e != nil {
				return nil, e
			}
			g, e := s.calculationSourceGrant(ctx, tx, ref, source)
			if e != nil {
				return nil, e
			}
			if source["subject_id"] != row["source_author_id"] || !s.Assistance.LegacySourceVisible(g, a.SubjectID) {
				return nil, fail("qualification_source_unavailable")
			}
			var payload Object
			if e = json.Unmarshal([]byte(str(source, "payload_text")), &payload); e != nil {
				return nil, e
			}
			event := object(payload["event"])
			if event == nil {
				event = payload
			}
			label := event["kind"]
			if label == nil {
				label = "task-created"
			}
			var summary any
			for _, key := range []string{"summary", "description", "agreedScope", "title"} {
				if event[key] != nil {
					summary = event[key]
					break
				}
			}
			out := Object{}
			for k, v := range ref {
				out[k] = v
			}
			out["label"], out["summary"] = label, summary
			return out, nil
		}()
		if e != nil {
			if !unavailable(e) {
				return nil, e
			}
			available = false
		} else {
			materials = append(materials, material)
		}
	}
	var target Object
	if s.Assistance == nil {
		return nil, fail("qualification_assistance_unavailable", 503)
	}
	current, e := s.Assistance.RequireTaskWithin(ctx, tx, &a, str(row, "task_id"), false)
	if e == nil {
		view, err := s.Assistance.ReadTaskWithin(ctx, tx, &a, str(row, "task_id"))
		e = err
		if e == nil {
			request := object(object(current["snapshot"])["request"])
			target = Object{"title": object(view["request"])["title"]}
			for _, key := range []string{"capabilityId", "qualification"} {
				if v, ok := request[key]; ok {
					target[key] = v
				}
			}
			if textView := object(view["textView"]); textView != nil {
				target["textView"] = Object{"title": object(textView["fields"])["title"]}
			}
		}
	}
	if e != nil && !unavailable(e) {
		return nil, e
	}
	events, e := readRows(ctx, tx, "SELECT to_jsonb(e) FROM qualification_permission_request_events e WHERE request_id=$1 ORDER BY version", row["id"])
	if e != nil {
		return nil, e
	}
	history := []any{}
	var grantID any
	for _, event := range events {
		if str(event, "payload_text") == "" {
			continue
		}
		g, e := s.requestGrant(ctx, tx, event)
		if e != nil {
			if !unavailable(e) {
				return nil, e
			}
			continue
		}
		if !s.Assistance.LegacySourceVisible(g, a.SubjectID) {
			continue
		}
		var p Object
		if e = json.Unmarshal([]byte(str(event, "payload_text")), &p); e != nil {
			return nil, e
		}
		history = append(history, Object{"eventId": event["id"], "kind": p["kind"], "version": event["version"], "reason": p["reason"], "by": event["subject_id"]})
		if p["kind"] == "record-permission" {
			grantID = p["grantId"]
		}
	}
	var permission Object
	if grantID != nil {
		g, e := s.readCalculationWithin(ctx, tx, a, text(grantID))
		if e != nil {
			if !unavailable(e) {
				return nil, e
			}
			permission = Object{"grantId": grantID, "state": "unavailable"}
		} else {
			permission = Object{"grantId": grantID, "state": "current", "expiresAt": g.Payload["expiresAt"]}
		}
	}
	if !available {
		base["state"] = "source-unavailable"
	}
	base["candidateId"], base["sourceAuthorId"], base["recipientId"], base["taskId"], base["target"], base["materials"], base["sourceRefs"] = row["subject_id"], row["source_author_id"], recipient["requester_id"], row["task_id"], target, materials, root["sourceRefs"]
	if row["subject_id"] == a.SubjectID {
		base["participationIds"], base["externalReviewRefs"] = root["participationIds"], root["externalReviewRefs"]
	}
	base["expiresAt"], base["history"], base["permission"], base["permissionGranted"], base["sourceReadGranted"] = expires.UTC().Format("2006-01-02T15:04:05.000Z"), history, permission, permission["state"] == "current", false
	base["grant"] = nil
	if available && row["source_author_id"] == a.SubjectID {
		base["grant"] = Object{"taskId": row["task_id"], "candidateId": row["subject_id"], "recipientId": recipient["requester_id"], "kind": "source-permission", "purpose": calculationPurpose, "expiresAt": base["expiresAt"], "sourceRefs": root["sourceRefs"], "disclosure": calculationDisclosure}
	}
	return base, nil
}
func (s *Service) ReadRequest(ctx context.Context, a Actor, input Object) (any, error) {
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) { return s.ReadRequestWithin(ctx, tx, a.Actor, input) })
}
