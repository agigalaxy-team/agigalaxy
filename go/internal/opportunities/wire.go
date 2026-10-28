package opportunities

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func ordered(x Object, keys ...string) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for _, k := range keys {
		if v, ok := x[k]; ok {
			o.Set(k, v)
		}
	}
	return o
}
func refWire(x Object) *protocol.OrderedObject {
	switch str(x, "sourceKind") {
	case "project":
		return ordered(x, "sourceKind", "subjectId", "projectId", "documentEventId", "policyEventId")
	case "recruitment":
		return ordered(x, "sourceKind", "subjectId", "projectId", "recruitmentId", "eventId")
	}
	return ordered(x, "subjectId", "projectId", "statementId")
}
func matchWire(x Object) *protocol.OrderedObject {
	o := ordered(x, "method", "score", "sharedFunctions", "purposes", "differences")
	o.Set("differences", ordered(obj(x, "differences"), "sourceOnlyFunctions", "candidateOnlyFunctions", "sourceOnlyTechnologies", "candidateOnlyTechnologies"))
	return o
}
func recruitmentWire(x Object) *protocol.OrderedObject {
	o := ordered(x, "schemaVersion", "recruitmentId", "projectId", "publisherId", "contactSubjectId", "revision", "state", "sourceEventId", "expiresAt", "objectKind", "taskAutomaticallyCreated", "document", "project", "acceptingContacts", "representativeCurrentlyAuthorized", "contactPreferenceEnabled", "classification", "capabilityVerified", "taskLinks", "taskLinkScope", "originalSource", "interpretation", "activeEntries")
	o.Set("document", ordered(obj(x, "document"), "title", "role", "summary", "functions", "technologies", "conditions", "contactSubjectId"))
	o.Set("project", ordered(obj(x, "project"), "projectId", "title", "classification"))
	links := []any{}
	for _, v := range objectItems(x["taskLinks"]) {
		links = append(links, ordered(v, "taskId", "linkedBy", "operationId", "linkedAt"))
	}
	o.Set("taskLinks", links)
	o.Set("originalSource", ordered(obj(x, "originalSource"), "operationId", "subjectId", "consentId", "payloadHash", "recordedAt"))
	return o
}
func (s *Service) cardWire(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, x Object) (*protocol.OrderedObject, error) {
	o := ordered(x, "id", "opportunityRef", "subjectId", "projectId", "recruitmentId", "project", "recruitment", "displayName", "participant", "classification", "capabilityVerified", "match", "help", "contactState", "willingness", "sources", "experience", "nextActions", "invitationSent", "roomJoined")
	ref := obj(x, "opportunityRef")
	o.Set("opportunityRef", refWire(ref))
	if ref["sourceKind"] == "project" {
		document, e := s.Projects.DocumentWireWithin(ctx, tx, a, str(x, "projectId"))
		if e != nil {
			return nil, e
		}
		document.Set("id", x["projectId"])
		o.Set("project", document)
	} else if ref["sourceKind"] == "recruitment" {
		o.Set("project", ordered(obj(x, "project"), "title", "role", "summary", "functions", "technologies", "conditions", "contactSubjectId", "id", "kind"))
		o.Set("recruitment", recruitmentWire(obj(x, "recruitment")))
	} else {
		o.Set("project", ordered(obj(x, "project"), "id", "kind", "title", "summary", "functions", "technologies", "sourceUrl", "discoverable"))
	}
	o.Set("participant", ordered(obj(x, "participant"), "subjectId", "kind", "kindSource"))
	o.Set("match", matchWire(obj(x, "match")))
	o.Set("help", ordered(obj(x, "help"), "statement", "functions", "purposes", "basis", "commitment"))
	o.Set("willingness", ordered(obj(x, "willingness"), "classification", "revision", "purposes", "temporaryUntil", "requiresRecipientAcceptance"))
	sources := []any{}
	for _, v := range objectItems(x["sources"]) {
		switch str(ref, "sourceKind") {
		case "project":
			source := ordered(v, "sourceKind", "projectId", "revision", "documentEventId", "policyEventId", "sourceStatementId", "fieldSources", "recordedAt", "sourceUrl")
			fields := []any{}
			for _, field := range objectItems(v["fieldSources"]) {
				fields = append(fields, ordered(field, "field", "operationId", "subjectId"))
			}
			source.Set("fieldSources", fields)
			sources = append(sources, source)
		case "recruitment":
			sources = append(sources, ordered(v, "operationId", "subjectId", "consentId", "payloadHash", "recordedAt"))
		default:
			sources = append(sources, ordered(v, "subjectId", "projectId", "statementId", "revision", "recordedAt", "sourceUrl"))
		}
	}
	o.Set("sources", sources)
	o.Set("experience", ordered(obj(x, "experience"), "status", "refs", "lookup", "absenceMeaning"))
	return o, nil
}
func (s *Service) pageWire(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, x Object) (*protocol.OrderedObject, error) {
	o := ordered(x, "schemaVersion", "items", "nextAfter", "enabled", "sourceContext", "computedAt", "method", "capabilityVerified", "activeEntries", "interpretation", "coverage", "disabledReason")
	items := []any{}
	for _, v := range objectItems(x["items"]) {
		card, e := s.cardWire(ctx, tx, a, v)
		if e != nil {
			return nil, e
		}
		items = append(items, card)
	}
	o.Set("items", items)
	source := ordered(obj(x, "sourceContext"), "kind", "ref", "persistedContext")
	if ref := obj(obj(x, "sourceContext"), "ref"); ref != nil {
		source.Set("ref", refWire(ref))
	}
	o.Set("sourceContext", source)
	o.Set("coverage", ordered(obj(x, "coverage"), "windowLimited", "scanWindowLimit", "ordering", "recruitmentPerSubjectLimit", "recruitmentFullPagination", "globalCountProvided", "globalRanking", "currentAuthorizedSources"))
	return o, nil
}

// QueryWire retains the original accepted record member order for Search's
// source fingerprints; it never hashes a sorted-map substitute.
func (s *Service) QueryWire(ctx context.Context, a *deviceauth.Actor, input Object) (json.RawMessage, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (json.RawMessage, error) { return s.QueryWireWithin(ctx, tx, a, input) })
}
func (s *Service) QueryWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (json.RawMessage, error) {
	page, e := s.QueryWithin(ctx, tx, a, input)
	if e != nil {
		return nil, e
	}
	wire, e := s.pageWire(ctx, tx, a, page)
	if e != nil {
		return nil, e
	}
	return protocol.EncodeJS(wire)
}
