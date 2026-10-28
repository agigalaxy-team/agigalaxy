package deviceauth

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"time"
)

// This opaque purpose capability replaces the original WeakMap registration.
// It cannot be received through JSON or created by an ordinary Bearer caller.
type informationWatchAuthority struct {
	watchID, bindingID, subject string
	revision                    int64
}

func watchDenied() error { return fault.New("information_watch_authorization_required", 403) }

// CheckInformationWatchWrite is used at each owning resource-write boundary.
// The accepted delegate permits only the watch's own notifications check path.
func CheckInformationWatchWrite(a Actor, scope string) error {
	if a.informationWatchAuthority != nil && scope != "notifications" {
		return watchDenied()
	}
	return nil
}
func watchObject(v any) map[string]any              { o, _ := v.(map[string]any); return o }
func watchString(o map[string]any, k string) string { s, _ := o[k].(string); return s }
func watchTruthy(v any) bool {
	switch v := v.(type) {
	case nil:
		return false
	case string:
		return v != ""
	case bool:
		return v
	case float64:
		return v != 0
	}
	return true
}
func watchScope(source map[string]any) (string, bool) {
	request := watchObject(source["request"])
	if source["kind"] == "honor" {
		return "history", true
	}
	if source["kind"] == "reference" {
		request = watchObject(request["search"])
	} else if source["kind"] != "search" {
		return "", false
	}
	switch watchString(request, "type") {
	case "case", "history", "opportunity":
		return "history", true
	case "task":
		return "assistance", true
	case "proof":
		return "proof", true
	case "capsule":
		return "capsules", true
	case "worker", "hub":
		return "builders", true
	}
	return "", false
}

// NewInformationWatchActor reads the currently accepted stored delegation. It
// is only for the fixed internal information-watch read dispatcher, never an
// HTTP/session issuer or an arbitrary subject/scope impersonation operation.
func (s *Service) NewInformationWatchActor(ctx context.Context, tx pgx.Tx, watchID, subject string, revision int64) (Actor, error) {
	if !bindingPattern.MatchString(watchID) || !consentSubject.MatchString(subject) || revision < 1 {
		return Actor{}, watchDenied()
	}
	var recordedBinding *string
	e := tx.QueryRow(ctx, `SELECT background_authority->>'bindingId' FROM information_watches_v2 WHERE id=$1 AND subject_id=$2 AND revision=$3 AND background_authority IS NOT NULL`, watchID, subject, revision).Scan(&recordedBinding)
	if errors.Is(e, pgx.ErrNoRows) {
		return Actor{}, watchDenied()
	}
	if e != nil {
		return Actor{}, e
	}
	if recordedBinding==nil||*recordedBinding==""{return Actor{},watchDenied()}
	bindingID:=*recordedBinding
	a := Actor{SubjectID: subject, BindingID: bindingID, informationWatchAuthority: &informationWatchAuthority{watchID: watchID, bindingID: bindingID, subject: subject, revision: revision}}
	row, e := s.watchAuthorizationWithin(ctx, tx, a)
	if e != nil {
		return Actor{}, e
	}
	a.Scopes = append([]string{}, row.Scopes...)
	a.DeviceID = row.Control.DeviceID
	a.KeyID = &row.Control.KeyID
	a.ControlEpoch = row.Control.Epoch
	return a, nil
}

func (s *Service) watchAuthorizationWithin(ctx context.Context, tx pgx.Tx, a Actor) (binding, error) {
	empty := binding{}
	cap := a.informationWatchAuthority
	if cap == nil || a.SubjectID != cap.subject || a.BindingID != cap.bindingID {
		return empty, watchDenied()
	}
	if _, e := lockSubject(ctx, tx, a.SubjectID); e != nil {
		return empty, e
	}
	var b binding
	e := tx.QueryRow(ctx, `SELECT id::text,subject_id,audience,device_id::text,key_id,control_epoch,scopes,expires_at,revoked_at FROM bindings WHERE id=$1 AND subject_id=$2 FOR SHARE`, cap.bindingID, a.SubjectID).Scan(&b.ID, &b.Subject, &b.Audience, &b.DeviceID, &b.KeyID, &b.Epoch, &b.Scopes, &b.Expires, &b.Revoked)
	if errors.Is(e, pgx.ErrNoRows) {
		return empty, watchDenied()
	}
	if e != nil {
		return empty, e
	}
	b.BindingScopes = append([]string{}, b.Scopes...)
	current, e := applyControl(ctx, tx, b)
	if e != nil {
		if fault.Code(e) != "internal_error" {
			return empty, watchDenied()
		}
		return empty, e
	}
	var revision int64
	var state string
	var expires time.Time
	var planRaw, authorityRaw []byte
	e = tx.QueryRow(ctx, `SELECT revision,state,expires_at,plan,background_authority FROM information_watches_v2 WHERE id=$1 AND subject_id=$2 FOR SHARE`, cap.watchID, a.SubjectID).Scan(&revision, &state, &expires, &planRaw, &authorityRaw)
	if errors.Is(e, pgx.ErrNoRows) {
		return empty, watchDenied()
	}
	if e != nil {
		return empty, e
	}
	var plan, authority map[string]any
	if json.Unmarshal(planRaw, &plan) != nil || json.Unmarshal(authorityRaw, &authority) != nil {
		return empty, watchDenied()
	}
	if current.Revoked != nil || current.Audience != s.Endpoint || !current.Expires.After(time.Unix(s.now(), 0)) || state != "active" || revision != cap.revision || !expires.After(time.Unix(s.now(), 0)) || watchString(authority, "bindingId") != cap.bindingID {
		return empty, watchDenied()
	}
	var device any
	if current.Control.DeviceID != nil {
		device = *current.Control.DeviceID
	}
	epoch := float64(0)
	if value := authority["controlEpoch"]; value != nil {
		var ok bool
		epoch, ok = value.(float64)
		if !ok {
			return empty, watchDenied()
		}
	}
	if authority["deviceId"] != device || watchTruthy(authority["keyId"]) && authority["keyId"] != current.Control.KeyID || epoch != float64(current.Control.Epoch) {
		return empty, watchDenied()
	}
	selections, ok := plan["sources"].([]any)
	if !ok || len(selections) < 1 || len(selections) > 4 {
		return empty, watchDenied()
	}
	required := []string{"notifications"}
	for _, v := range selections {
		scope, ok := watchScope(watchObject(watchObject(v)["source"]))
		if !ok {
			return empty, watchDenied()
		}
		if !contains(required, scope) {
			required = append(required, scope)
		}
	}
	accepted, ok := authority["scopes"].([]any)
	if !ok {
		return empty, watchDenied()
	}
	for _, scope := range required {
		allowed := false
		for _, s := range accepted {
			if s == scope {
				allowed = true
				break
			}
		}
		if !allowed || !contains(current.Scopes, scope) {
			return empty, watchDenied()
		}
	}
	current.Scopes = required
	return current, nil
}
