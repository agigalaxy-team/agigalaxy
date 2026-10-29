package messaging

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// noticeReadContentWithin derives only a verified read shape; it does not change
// the closed standalone notice command parser or confer publishing authority.
func (s *Service) noticeReadContentWithin(ctx context.Context, tx pgx.Tx, row Object) (Object, Object, error) {
	raw := obj(row["content"])
	if _, hasMarker := raw["messagingRunId"]; !hasMarker {
		content, e := ParseNoticeContent(raw)
		if e != nil {
			return nil, nil, failure("operations_notice_source_unverified", 503)
		}
		return content, Object{"kind": "notice"}, nil
	}
	runID := str(raw["messagingRunId"])
	if !uuidOK(runID) || runID != str(row["id"]) {
		return nil, nil, failure("operations_notice_source_unverified", 503)
	}
	run, e := s.runWithin(ctx, tx, runID, false)
	if e != nil {
		return nil, nil, failure("operations_notice_source_unverified", 503)
	}
	config, e := ParseConfiguration(run["config"])
	if e != nil {
		return nil, nil, failure("operations_notice_source_unverified", 503)
	}
	if !contains(list(config["channels"]), "inapp") {
		return nil, nil, failure("operations_notice_source_unverified", 503)
	}
	expected := obj(clone(config["content"]))
	expected["audience"] = config["audience"]
	expected["messagingRunId"] = runID
	if !same(raw, expected) {
		return nil, nil, failure("operations_notice_source_unverified", 503)
	}
	delete(expected, "messagingRunId")
	return expected, Object{"kind": "message-plan-run", "planId": run["plan_id"], "planVersion": run["plan_version"], "runId": runID}, nil
}
