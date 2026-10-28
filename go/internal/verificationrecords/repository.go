// Package verificationrecords owns the retained v2 declared Evidence and
// Verification object/event ledger. Reports never establish external ownership
// or independently verified task outcome, capability or execution.
package verificationrecords

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

type recordObject struct {
	ID, Type, CaseID, Subject, State string
	Version                          int64
}
type recordEvent struct {
	OperationID, ObjectID, ConsentID, PayloadText, Hash string
	Version                                             int64
	Payload, Context                                    Object
	Created                                             time.Time
}

func loadObject(ctx context.Context, tx pgx.Tx, id, lock string) (*recordObject, error) {
	var r recordObject
	query := `SELECT id::text,object_type,case_id::text,subject_id,version,state FROM verification_objects WHERE id=$1`
	if lock == "SHARE" || lock == "UPDATE" {
		query += " FOR " + lock
	}
	e := tx.QueryRow(ctx, query, id).Scan(&r.ID, &r.Type, &r.CaseID, &r.Subject, &r.Version, &r.State)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	return &r, e
}
func loadEvent(ctx context.Context, tx pgx.Tx, id string, version int64, operation bool) (*recordEvent, error) {
	query := `SELECT operation_id::text,object_id::text,version,consent_id::text,payload,payload_text,payload_hash,context,created_at FROM verification_events WHERE object_id=$1 AND version=$2`
	args := []any{id, version}
	if operation {
		query = `SELECT operation_id::text,object_id::text,version,consent_id::text,payload,payload_text,payload_hash,context,created_at FROM verification_events WHERE operation_id=$1`
		args = []any{id}
	}
	var r recordEvent
	var payload, contextRaw []byte
	e := tx.QueryRow(ctx, query, args...).Scan(&r.OperationID, &r.ObjectID, &r.Version, &r.ConsentID, &payload, &r.PayloadText, &r.Hash, &contextRaw, &r.Created)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if e = protocol.Decode(payload, &r.Payload); e != nil {
		return nil, e
	}
	e = protocol.Decode(contextRaw, &r.Context)
	return &r, e
}
func appendEvent(ctx context.Context, tx pgx.Tx, data Object, consent, payload, hash string, derived Object) error {
	if _, e := tx.Exec(ctx, `INSERT INTO verification_events(operation_id,object_id,version,consent_id,payload,payload_text,payload_hash,context) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb)`, data["operationId"], data["id"], num(data, "expectedVersion")+1, consent, payload, payload, hash, string(encode(derived))); e != nil {
		return e
	}
	state := "active"
	if data["kind"] == "revoke" {
		state = "revoked"
	}
	_, e := tx.Exec(ctx, `UPDATE verification_objects SET version=$2,state=$3 WHERE id=$1`, data["id"], num(data, "expectedVersion")+1, state)
	return e
}
func dependencies(ctx context.Context, tx pgx.Tx, data Object) error {
	if data["kind"] != "verification" {
		return nil
	}
	refs := []Object{obj(data["target"])}
	for _, v := range arr(data["evidenceRefs"]) {
		ref := copyObject(obj(v))
		ref["type"] = "evidence"
		refs = append(refs, ref)
	}
	for _, ref := range refs {
		if _, e := tx.Exec(ctx, `INSERT INTO verification_dependencies(object_id,object_version,target_type,target_id,target_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, data["id"], num(data, "expectedVersion")+1, ref["type"], ref["id"], ref["version"]); e != nil {
			return e
		}
	}
	return nil
}
