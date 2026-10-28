package choices

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) PurgeExpired(ctx context.Context) (Object, error) {
	if s == nil || s.Pool == nil {
		return nil, fail("choice_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.PurgeExpiredWithin(ctx, tx) })
}
func (s *Service) PurgeInvalidSources(ctx context.Context, after string, limit int) (Object, error) {
	if s == nil || s.Pool == nil {
		return nil, fail("choice_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.PurgeInvalidSourcesWithin(ctx, tx, after, limit) })
}
func (s *Service) PurgeInvalidSourcesWithin(ctx context.Context, tx pgx.Tx, after string, limit int) (Object, error) {
	if limit < 1 || limit > 20 {
		return nil, fail("invalid_choice_cleanup", 400)
	}
	if s.ErasureViewWithin == nil {
		return nil, fail("choice_erasure_source_authority_unavailable", 503)
	}
	var cursor any
	if after != "" {
		if e := json.Unmarshal([]byte(after), &cursor); e != nil {
			return nil, e
		}
	}
	c := object(cursor)
	records, e := rows(ctx, tx, "SELECT jsonb_build_object('subject_id',subject_id,'snapshot_id',snapshot_id,'version_id',version_id) FROM choice_snapshot_versions WHERE state IN ('current','conflict') AND NOT (content ? 'rationaleUnavailable') AND ($1::uuid IS NULL OR (version_id,subject_id)>($1::uuid,$2::text)) ORDER BY version_id,subject_id LIMIT $3", c["versionId"], c["subjectId"], limit+1)
	if e != nil {
		return nil, e
	}
	redacted := 0
	for _, selected := range records[:min(len(records), limit)] {
		if _, e = row(ctx, tx, "SELECT jsonb_build_object('snapshot_id',snapshot_id) FROM choice_snapshot_heads WHERE subject_id=$1 AND snapshot_id=$2 FOR UPDATE", selected["subject_id"], selected["snapshot_id"]); e != nil {
			return nil, e
		}
		record, e := row(ctx, tx, "SELECT to_jsonb(v) FROM choice_snapshot_versions v WHERE subject_id=$1 AND version_id=$2", selected["subject_id"], selected["version_id"])
		if e != nil {
			return nil, e
		}
		if record == nil || (record["state"] != "current" && record["state"] != "conflict") {
			continue
		}
		view, e := s.ErasureViewWithin(ctx, tx, str(record, "subject_id"), record)
		if e != nil {
			return nil, e
		}
		shouldErase := false
		for _, status := range array(view["sourceStatus"]) {
			state := object(status)["state"]
			if state == "changed" || state == "unavailable" {
				shouldErase = true
			}
		}
		if object(view["content"])["rationaleUnavailable"] == true && shouldErase {
			if _, e = tx.Exec(ctx, "UPDATE choice_snapshot_versions SET content=(content-'visibleRationale')||'{\"rationaleUnavailable\":true,\"visibleRationale\":null}'::jsonb WHERE subject_id=$1 AND version_id=$2", record["subject_id"], record["version_id"]); e != nil {
				return nil, e
			}
			redacted++
		}
	}
	var next any
	if len(records) > limit {
		last := records[limit-1]
		raw, e := protocol.EncodeJS(ordered("versionId", last["version_id"], "subjectId", last["subject_id"]))
		if e != nil {
			return nil, e
		}
		next = string(raw)
	}
	return Object{"checked": min(len(records), limit), "redacted": redacted, "nextAfter": next}, nil
}
