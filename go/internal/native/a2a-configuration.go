package native

import (
	"encoding/json"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
	whatwg "github.com/nlnwa/whatwg-url/url"
)

type a2aPeer struct {
	id, name, endpoint, tenant, principal, cardHash, authMode, authVariable string
	card                                                                    *protocol.OrderedObject
	trustExpiresAt                                                          int64
	hasName, hasTenant                                                      bool
}

// A2aOptions never reads ambient environment. ReadEnvironment is the explicitly
// supplied child-process lookup and is used only for the chosen named peer.
type A2aOptions struct {
	Post            A2aPost
	ReadEnvironment func(string) (string, bool)
	Now             func() time.Time
}

func a2aConfiguration(raw []byte) ([]a2aPeer, error) {
	var schema, value map[string]any
	if protocol.Decode([]byte(a2aConfigurationSchemaJSON), &schema) != nil || json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, a2aError("invalid configured peers")
	}
	remoteDefaults(schema, value)
	if remoteChatValidate(schema, value) != nil {
		return nil, a2aError("invalid configured peers")
	}
	ordered, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	source := a2aObject(ordered)
	seen := map[string]bool{}
	peers := []a2aPeer{}
	for _, v := range uploadRows(source["peers"]) {
		p := a2aObject(v)
		id := text(p["id"])
		if seen[id] {
			return nil, a2aError("unique configured peer IDs required")
		}
		seen[id] = true
		card, ok := p["agentCard"].(*protocol.OrderedObject)
		if !ok {
			return nil, a2aError("configured AgentCard required")
		}
		auth := a2aObject(p["authentication"])
		mode := text(auth["mode"])
		if mode == "" {
			mode = "none"
		}
		_, hasName := p["name"]
		_, hasTenant := p["tenant"]
		peers = append(peers, a2aPeer{id: id, name: text(p["name"]), endpoint: text(p["endpoint"]), tenant: text(p["tenant"]), principal: text(p["peerPrincipal"]), cardHash: text(p["cardHash"]), card: card, trustExpiresAt: a2aInteger(p["trustExpiresAt"]), authMode: mode, authVariable: text(auth["variable"]), hasName: hasName, hasTenant: hasTenant})
	}
	return peers, nil
}
func (p a2aPeer) authorize(now time.Time, environment func(string) (string, bool)) (string, error) {
	card, e := protocol.EncodeJS(p.card)
	if e != nil || a2aHash(card) != p.cardHash || p.trustExpiresAt <= now.UnixMilli() {
		return "", a2aError("current configured AgentCard trust required")
	}
	parsed, e := whatwg.Parse(p.endpoint)
	if e != nil || !publicfetch.ValidURL(parsed.String()) {
		return "", a2aError("unsafe configured peer interface")
	}
	matched := false
	interfaces, ok := p.card.Values()["supportedInterfaces"].([]any)
	if !ok {
		interfaces = uploadRows(p.card.Values()["supported_interfaces"])
	}
	for _, item := range interfaces {
		v := a2aObject(item)
		binding := v["protocolBinding"]
		if binding == nil {
			binding = v["protocol_binding"]
		}
		version := v["protocolVersion"]
		if version == nil {
			version = v["protocol_version"]
		}
		if a2aJSString(v["url"]) == p.scope("", "").Endpoint && a2aJSString(v["tenant"]) == p.tenant && a2aJSString(binding) == "JSONRPC" && a2aJSString(version) == "1.0" {
			matched = true
			break
		}
	}
	if !matched {
		return "", a2aError("explicit A2A 1.0 JSONRPC interface required")
	}
	if p.authMode == "none" {
		return "", nil
	}
	if p.authMode != "bearer-environment" || environment == nil {
		return "", a2aError("external authorization unavailable")
	}
	credential, ok := environment(p.authVariable)
	if !ok || !a2aCredentialValid(credential) {
		return "", a2aError("configured external credential unavailable")
	}
	return credential, nil
}
func (p a2aPeer) scope(subject, official string) a2aJournalScope {
	u, e := whatwg.Parse(p.endpoint)
	endpoint := p.endpoint
	if e == nil {
		endpoint = u.String()
	}
	return a2aJournalScope{subject, official, endpoint, p.tenant, p.principal}
}
