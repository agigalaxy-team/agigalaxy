package systemsettings

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) authorizeNativeWithin(ctx context.Context, tx pgx.Tx, value Object) (Actor, Object, error) {
	kind := "credential"
	if value["kind"] == "settings-test" {
		kind = "test"
	} else if value["kind"] == "settings-apply" {
		kind = "apply"
	}
	row, e := s.row(ctx, tx, str(value["operationId"]))
	if e != nil {
		return Actor{}, nil, e
	}
	denied := func() (Actor, Object, error) { return Actor{}, nil, fail("system_settings_permission_denied", 403) }
	if row == nil || row["kind"] != kind || row["section"] != value["section"] || row["operator_id"] != value["operatorId"] || !pendingState(row) {
		return denied()
	}
	if s.StoredAuthority == nil {
		return Actor{}, nil, fail("system_settings_authorization_unavailable", 503)
	}
	if e = s.StoredAuthority.Revalidate(ctx, tx, str(row["operator_id"]), actions[kind]); e != nil {
		return Actor{}, nil, e
	}
	actor, e := s.StoredAuthority.PersonWithin(ctx, tx, str(row["operator_id"]), false)
	if e != nil {
		return Actor{}, nil, e
	}
	if actor.ID != row["operator_id"] || actor.Endpoint != s.Endpoint || !includes(actor.Permissions, actions[kind]) {
		return denied()
	}
	head, e := s.head(ctx, tx, str(row["section"]))
	if e != nil {
		return Actor{}, nil, e
	}
	if kind == "credential" {
		expected := CredentialMetadata(value)
		delete(expected, "kind")
		delete(expected, "operatorId")
		if !same(expected, row["input"]) || num(head["revision"]) != num(obj(row["input"])["expectedRevision"]) {
			return denied()
		}
	} else {
		version, e := s.version(ctx, tx, row["version_id"], str(row["section"]))
		if e != nil {
			return Actor{}, nil, e
		}
		if version == nil || value["versionId"] != row["version_id"] || num(value["revision"]) != num(row["revision"]) || num(head["revision"]) != num(row["revision"]) || head["version_id"] != row["version_id"] || kind == "apply" && head["pending_operation"] != row["operation_id"] || !same(value["configuration"], version["configuration"]) || !same(value["connectionId"], obj(row["input"])["connectionId"]) {
			return denied()
		}
	}
	return actor, row, nil
}
func (s *Service) AuthorizeNative(ctx context.Context, input Object) (Object, error) {
	value, e := ParseNativeCommand(input, true)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, row, e := s.authorizeNativeWithin(ctx, tx, value)
		if e != nil {
			return nil, e
		}
		return Object{"authorized": true, "operationId": value["operationId"], "operatorId": actor.ID, "section": row["section"], "kind": value["kind"], "endpoint": s.Endpoint}, nil
	})
}
