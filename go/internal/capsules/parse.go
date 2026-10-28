package capsules

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// ParseRequestV2 is the same pure request parser consumed by the current HTTP
// service. It does not authorize reading, sign/re-encode a submitted envelope,
// or construct a Capsule from a client's preview.
func ParseRequestV2(kind string, raw []byte) (Object, error) {
	switch kind {
	case "permissions-query":
		kind = "permissions"
	case "uses-query":
		kind = "uses"
	}
	return parseInput(raw, kind)
}

// ParsePayloadV2 normalizes a newly constructed unsigned payload with the
// original schema. Existing Consent JWS/payload_text must bypass this helper.
func ParsePayloadV2(kind, payload string) (json.RawMessage, error) {
	if kind != "event" && kind != "use" && kind != "permission" {
		return nil, fault.New("invalid_capsule_v2_payload", 400)
	}
	value, e := parsePayload(payload, kind, true)
	if e != nil {
		return nil, e
	}
	return protocol.EncodeJS(value)
}
