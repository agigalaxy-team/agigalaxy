package hubs

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func (p *Peering) validateResponse(ctx context.Context, data []byte, ag peerAgreement) (*protocol.OrderedObject, error) {
	parsed, e := parsedWire("peerResponseSchema", data)
	if e != nil {
		return nil, fault.New("peering_response_invalid", 409)
	}
	v := parsed.Values()
	now := p.Hubs.now()
	agreement := ag.agreement.Values()
	items := arr(v["items"])
	if len(items) > int(num(agreement, "pageSize"))+20 || num(v, "checkedAt") > now || num(v, "expiresAt") <= now || num(v, "expiresAt") > num(v, "checkedAt")+num(agreement, "responseMaxAgeSeconds") {
		return nil, fault.New("peering_response_invalid", 409)
	}
	seen := map[string]bool{}
	groupOrder := []string{}
	groups := map[string]Object{}
	expiry := min(num(v, "expiresAt"), num(agreement, "expiresAt"))
	for _, raw := range items {
		item := obj(raw)
		id := txt(item, "grantId")
		if seen[id] {
			return nil, fault.New("peering_response_invalid", 409)
		}
		seen[id] = true
		if item["state"] != "current" {
			continue
		}
		if item["issuer"] != ag.remote["endpoint"] || num(item, "observedAt") > now || num(item, "expiresAt") <= now {
			return nil, fault.New("peering_source_invalid", 409)
		}
		source := obj(item["sourceObject"])
		if source["kind"] == "ci-proof-v2" {
			if !has(arr(agreement["sourceKinds"]), "ci-proof-v2") {
				return nil, fault.New("peering_kind_not_agreed", 409)
			}
			checked, e := p.verify(ctx, txt(item, "signed"), "proof", txt(ag.remote, "endpoint"), remotePins(ag.remote), now, 86400)
			if e != nil {
				return nil, errors.New("unverified original peer proof")
			}
			proof, e := civ2.ParseProof(checked.Data)
			if e != nil {
				return nil, e
			}
			original, e := wireDecode(checked.Data)
			if e != nil {
				return nil, e
			}
			originalJSON, e := wireEncode(original)
			if e != nil {
				return nil, e
			}
			provenance, e := civ2.DescribeProof(original)
			if e != nil {
				return nil, e
			}
			if proof["id"] != source["id"] || identity.Digest(originalJSON) != source["payloadHash"] || proof["subject"] != item["subjectId"] || proof["synthetic"] != item["synthetic"] || provenance["sourceKey"] != item["sourceKey"] || num(proof, "observedAt") != num(item, "observedAt") || num(item, "expiresAt") > num(proof, "expiresAt") {
				return nil, fault.New("peering_proof_mismatch", 409)
			}
			// Clamp display lifetime while preserving the original proof token/data.
			narrowed := min(num(item, "expiresAt"), checked.ExpiresAt)
			if o, ok := raw.(*protocol.OrderedObject); ok {
				o.Set("expiresAt", narrowed)
			} else {
				item["expiresAt"] = narrowed
			}
			key := txt(item, "sourceKey")
			group := groups[key]
			if group == nil {
				group = Object{"records": int64(0), "commits": []any{}, "conclusions": []any{}}
				groups[key] = group
				groupOrder = append(groupOrder, key)
			}
			group["records"] = num(group, "records") + 1
			commit := obj(proof["source"])["commit"]
			if !has(arr(group["commits"]), commit) {
				group["commits"] = append(arr(group["commits"]), commit)
			}
			if !has(arr(group["conclusions"]), proof["conclusion"]) {
				group["conclusions"] = append(arr(group["conclusions"]), proof["conclusion"])
			}
		} else {
			keyJSON, _ := wireEncode([]any{ag.remote["endpoint"], source["kind"], source["id"], source["payloadHash"]})
			if !has(arr(agreement["sourceKinds"]), "contribution-summary") || obj(item["projection"])["actorId"] != item["subjectId"] || item["sourceKey"] != identity.Digest(keyJSON) {
				return nil, fault.New("peering_summary_mismatch", 409)
			}
		}
		expiry = min(expiry, num(item, "expiresAt"))
	}
	if expiry <= now {
		return nil, fault.New("peering_response_expired", 409)
	}
	outGroups := []any{}
	for _, key := range groupOrder {
		group := groups[key]
		conflicts := []any{}
		if len(arr(group["commits"])) > 1 {
			conflicts = append(conflicts, "commit")
		}
		if len(arr(group["conclusions"])) > 1 {
			conflicts = append(conflicts, "conclusion")
		}
		outGroups = append(outGroups, ordered("sourceKey", key, "proofRecords", group["records"], "conflicts", conflicts, "independentEvidenceAdded", 0))
	}
	parsed.Set("expiresAt", expiry)
	parsed.Set("sourceGroups", outGroups)
	parsed.Set("scopeMeaning", "Peer-authorized finite observations; no automatic result acceptance, resolution or capability certification")
	return parsed, nil
}
