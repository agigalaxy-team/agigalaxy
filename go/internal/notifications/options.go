package notifications

import (
	"context"
	"strconv"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func stringNumber(n int64) string { return strconv.FormatInt(n, 10) }
func ParseOptions(p Object) (Object, error) {
	if p == nil {
		p = Object{}
	}
	fields := []string{"rooms", "tasks", "mutedRoomIds", "blockedSubjectIds", "roomBlocks"}
	if !shape(p, nil, fields) {
		return nil, fail("invalid_inbox_request", 400)
	}
	for _, key := range []string{"rooms", "tasks"} {
		if _, ok := p[key]; !ok {
			p[key] = true
		}
		if _, ok := p[key].(bool); !ok {
			return nil, fail("invalid_inbox_request", 400)
		}
	}
	for _, key := range []string{"mutedRoomIds", "blockedSubjectIds", "roomBlocks"} {
		if _, ok := p[key]; !ok {
			p[key] = []any{}
		}
		values, ok := p[key].([]any)
		if !ok || len(values) > 256 {
			return nil, fail("invalid_inbox_request", 400)
		}
		for _, value := range values {
			switch key {
			case "mutedRoomIds":
				if !validID(text(value)) {
					return nil, fail("invalid_inbox_request", 400)
				}
			case "blockedSubjectIds":
				if !subjectPattern.MatchString(text(value)) {
					return nil, fail("invalid_inbox_request", 400)
				}
			case "roomBlocks":
				v := object(value)
				if !shape(v, []string{"roomId", "subjectId"}, nil) || !validID(str(v, "roomId")) || !subjectPattern.MatchString(str(v, "subjectId")) {
					return nil, fail("invalid_inbox_request", 400)
				}
			}
		}
	}
	return p, nil
}
func (s *Service) OptionsWithin(ctx context.Context, tx pgx.Tx, subjectID string) (Object, error) {
	current, e := one(ctx, tx, "SELECT to_jsonb(o) FROM notification_options_v2 o WHERE subject_id=$1", subjectID)
	if e != nil {
		return nil, e
	}
	settings := Object{}
	if current != nil {
		settings = object(current["settings"])
	}
	settings, e = ParseOptions(settings)
	if e != nil {
		return nil, e
	}
	return Object{"revision": num(current["revision"]), "settings": settings, "externalDelivery": "disabled"}, nil
}
func (s *Service) Options(ctx context.Context, a Actor) (any, error) {
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		return s.OptionsWithin(ctx, tx, a.SubjectID)
	})
}
func (s *Service) SaveOptions(ctx context.Context, a Actor, input Object) (any, error) {
	if !shape(input, []string{"expectedRevision", "settings"}, nil) || !integer(input["expectedRevision"], 0, 9007199254740991) {
		return nil, fail("invalid_inbox_request", 400)
	}
	settings, e := ParseOptions(object(input["settings"]))
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		defaults, _ := ParseOptions(Object{})
		if _, e := tx.Exec(ctx, "INSERT INTO notification_options_v2(subject_id,settings,updated_at)VALUES($1,$2::jsonb,$3)ON CONFLICT DO NOTHING", a.SubjectID, encode(defaults), stamp(s.now())); e != nil {
			return nil, e
		}
		current, e := one(ctx, tx, "SELECT to_jsonb(o) FROM notification_options_v2 o WHERE subject_id=$1 FOR UPDATE", a.SubjectID)
		if e != nil {
			return nil, e
		}
		if num(current["revision"]) != num(input["expectedRevision"]) {
			return nil, fail("inbox_options_conflict")
		}
		if _, e = tx.Exec(ctx, "UPDATE notification_options_v2 SET settings=$2::jsonb,revision=revision+1,updated_at=$3 WHERE subject_id=$1", a.SubjectID, encode(settings), stamp(s.now())); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, auth, "notification.preferences", a.SubjectID, "inbox-v2:"+stringNumber(num(current["revision"])+1)); e != nil {
			return nil, e
		}
		return s.OptionsWithin(ctx, tx, a.SubjectID)
	})
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a Actor, auth deviceauth.ControlAuthorization, action, id, idempotency string) error {
	if !contains([]string{"notification.preferences", "notification.read", "notification.archive"}, action) || !contains(auth.CredentialScopes, "notifications") {
		return fail("notification_audit_unavailable", 503)
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)SELECT $1,$2,$3::text,$4::text,'accepted',1,ch.payload->>'installationId',b.audience,'notifications',b.id,$5::uuid,$4::text,b.scopes,$6::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$7::uuid AND b.subject_id=$1 AND b.scopes ? 'notifications'`, a.SubjectID, action, id, idempotency, a.HTTPRequestID, encode(auth.CredentialScopes), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail("notification_audit_unavailable", 503)
	}
	return nil
}
