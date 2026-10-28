package main

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/trustpackages"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
)

func trustService(cs *cases.Service, records *verificationrecords.Service, cfg *configurations.Service, rooms *chat.Service, tasks *taskmaterials.Service, outcome *taskmaterials.OutcomeService, ci *civ2.Service, budget *resourcebudget.Service) *trustpackages.Service {
	cs.GrantAuthorTaskRead = tasks.ReadGrantAuthorWithin
	cs.GrantAuthorConfigurationCondition = cfg.ConditionGrantAuthorWithin
	cs.GrantAuthorVerificationReference = func(ctx context.Context, tx pgx.Tx, author string, ref cases.Object, caseID string, scope int64) (cases.Object, error) {
		return records.RequireReferenceGrantAuthorWithin(ctx, tx, author, ref, verificationrecords.ReferenceOptions{CaseID: caseID, ScopeVersion: &scope})
	}
	cs.GrantAuthorSources = func(ctx context.Context, tx pgx.Tx, author string, ref, info cases.Object) (cases.Object, error) {
		caseID, _ := info["caseId"].(string)
		visited, _ := info["visited"].(map[string]bool)
		switch ref["kind"] {
		case "evidence", "verification":
			return records.RequireReferenceGrantAuthorWithin(ctx, tx, author, ref, verificationrecords.ReferenceOptions{CaseID: caseID, Visited: visited})
		case "configuration":
			return cfg.RequireReferenceGrantAuthorWithin(ctx, tx, author, ref)
		case "outcome-material":
			return outcome.RequireReferenceGrantAuthorWithin(ctx, tx, author, ref, caseID)
		case "selected-message":
			// The owning chat reader supplies the original archive/current-source
			// checks; metadata-only authority is not a substitute for that read.
			if rooms != nil {
				id, _ := ref["id"].(string)
				var revision int64
				switch v := ref["version"].(type) {
				case int64:
					revision = v
				case float64:
					revision = int64(v)
				case int:
					revision = int64(v)
				}
				return rooms.ReadSelectedGrantAuthorWithin(ctx, tx, author, id, revision)
			}
		}
		return nil, fault.New("source_adapter_unavailable", 503)
	}
	reader := &trustpackages.SourceReader{Endpoint: cs.Endpoint, Cases: cs, Records: records, CI: ci, ReadCaseAsAuthor: cs.ReadV2GrantAuthorWithin, ReadRecordAsAuthor: records.ReadGrantAuthorWithin, Now: cs.Now}
	s := trustpackages.New(cs.Pool, cs.Endpoint, cs.Devices, cs.Now)
	s.Resources = budget
	s.ReadSource = reader.ReadWithin
	s.ReadAuthorSource = reader.ReadAuthorWithin
	return s
}
