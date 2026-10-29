package agentos

import (
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestConversationPublicReferenceOriginalContract(t *testing.T) {
	id, version, other := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
	cases := []Object{
		{"reference": Object{"kind": "post", "id": id}, "args": Object{"kind": "post", "id": id}, "current": Object{}},
		{"reference": Object{"kind": "post", "id": id, "versionId": version}, "args": Object{"kind": "post", "id": id}, "current": Object{"versionId": version}},
		{"reference": Object{"kind": "post", "id": id, "versionId": version}, "args": Object{"kind": "post", "id": id}, "current": Object{"versionId": other}},
		{"reference": Object{"kind": "reply", "id": id}, "args": Object{"kind": "post", "id": id}, "current": Object{}},
		{"reference": Object{"kind": "reply", "id": id, "versionId": version}, "args": Object{"kind": "reply", "id": id}, "current": Object{}},
		{"reference": Object{"kind": "post", "id": id, "url": "https://example.invalid"}, "args": Object{}, "current": Object{}},
		{"reference": nil, "args": Object{}, "current": Object{}},
	}
	// Exact acceptance, error and canonical digest values captured from the original contract.
	original := []struct {
		Parsed       bool
		Code, Digest string
	}{
		{true, "", "3723fa1a0214a490e8e158191f819a56d354fd037c14d041d6872ad8682d5d24"},
		{true, "", "d36225815277d141f249aac1c6d2374c8a35d7cee7c58fdfbf00888423c81158"},
		{true, "operations_agentos_source_changed", "d36225815277d141f249aac1c6d2374c8a35d7cee7c58fdfbf00888423c81158"},
		{true, "invalid_operations_agentos_request", "d6e36d06dd42e508011fddb633b842b2e41bdea2b36fdb71f442ba9c65fea7d0"},
		{false, "", ""}, {false, "", ""}, {false, "", ""},
	}
	for i, input := range cases {
		ref, err := parseConversationPublicReference(input["reference"])
		if (err == nil) != original[i].Parsed {
			t.Fatalf("case %d schema differs", i)
		}
		if err != nil {
			continue
		}
		err = checkConversationPublicReference(ref, object(input["args"]), object(input["current"]))
		code := ""
		if err != nil {
			code = fault.Code(err)
		}
		digest, digestErr := conversationArgumentsDigest(object(input["args"]), ref)
		if digestErr != nil || code != original[i].Code || digest != original[i].Digest {
			t.Fatalf("case %d check/digest differs", i)
		}
	}
}
