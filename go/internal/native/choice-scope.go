package native

import (
	"context"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
)

type ChoiceScope struct {
	Owner, Endpoint, DeviceID string
	Revision                  int64
}

func (s *Store) choiceScopeWithin(dir string) (ChoiceScope, error) {
	owner, e := s.ownerWithin(dir, "")
	if e != nil {
		return ChoiceScope{}, e
	}
	scope := ChoiceScope{Owner: owner, Endpoint: s.Endpoint}
	var record map[string]any
	ok, e := readJSON(filepath.Join(dir, "native-v2", "records", identity.Digest([]byte("native-selection:"+s.Endpoint))+".json"), &record)
	if e != nil {
		return scope, e
	}
	if ok {
		scope.Revision = integer(record["revision"])
		if active, ok := record["active"].(map[string]any); ok {
			scope.DeviceID = text(active["deviceId"])
		}
	} else {
		var active map[string]any
		_, e = readJSON(filepath.Join(dir, "native-v2", "records", identity.Digest([]byte("native-active:"+s.Endpoint))+".json"), &active)
		if e != nil {
			return scope, e
		}
		scope.DeviceID = text(active["deviceId"])
	}
	return scope, nil
}
func (s *Store) ChoiceScope(ctx context.Context) (scope ChoiceScope, e error) {
	e = s.With(ctx, false, func(dir string) error { var err error; scope, err = s.choiceScopeWithin(dir); return err })
	return
}
func (s *Store) verifyChoiceWithin(dir string, expected *ChoiceScope) error {
	if expected == nil {
		return nil
	}
	current, e := s.choiceScopeWithin(dir)
	if e != nil {
		return e
	}
	if current != *expected {
		return fault.New("native_choice_binding_changed", 409)
	}
	return nil
}
