package builders

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"strings"
)

// ReadChoiceWireWithin is the original Choice builderList source. The optional
// query only checks source search fields; no query is persisted in the locator.
func (s *Service) ReadChoiceWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (json.RawMessage, error) {
	item, e := s.ReadWithin(ctx, tx, a, Object{"builderId": input["builderId"]})
	if e != nil {
		return nil, e
	}
	if item["delisted"] == true {
		return nil, fault.New("choice_source_unavailable", 409)
	}
	d := obj(item["declaration"])
	fields := searchFields(d)
	lower := cases.Lower(language.English)
	terms := []string{}
	for _, term := range strings.FieldsFunc(lower.String(txt(input, "query")), jsSpace) {
		if !contains(terms, term) {
			terms = append(terms, term)
		}
	}
	matches := []string{}
	for _, term := range terms {
		keys := []string{}
		for _, field := range fields {
			if strings.Contains(lower.String(field.value), term) {
				keys = append(keys, field.key)
			}
		}
		if len(keys) == 0 {
			return nil, fault.New("choice_source_unavailable", 409)
		}
		matches = append(matches, term+" → "+strings.Join(keys, ", "))
	}
	if len(matches) == 0 {
		matches = append(matches, "current public declaration; source ID order")
	}
	wire := ordered("builderId", item["builderId"], "ownerId", item["ownerId"], "type", item["type"], "name", d["name"], "version", obj(d["release"])["version"], "registration", orderKeys(obj(item["registration"]), "state", "control"), "nodeControl", orderKeys(obj(item["nodeControl"]), "state", "capabilityVerified", "endpointControlVerified", "controlId", "nodeId", "ownerId", "expiresAt", "authority"), "compatibility", orderKeys(obj(item["compatibility"]), "state", "fullScopeState", "blockedByMaintenance", "capabilityVerified"), "reachability", orderKeys(obj(item["reachability"]), "state", "receivedAt", "eventId", "endpointProbed", "endpointReachable", "capabilityVerified", "scope", "endpointControlVerified", "reason", "requestId", "endpoint", "cardUrl", "observation", "job"), "evidence", obj(item["evidence"])["state"], "securityIssue", item["securityIssue"], "revision", item["revision"], "declarationId", item["declarationId"], "declarationHash", item["declarationHash"], "scope", d["scope"], "matchReasons", matches)
	raw, e := protocol.EncodeJS(wire)
	return json.RawMessage(raw), e
}
