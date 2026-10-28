package agentos

import "github.com/agigalaxy-team/agigalaxy/go/internal/identity"

// This private transport locator restricts an already authorized source. It
// neither grants read permission nor supplies a model-selected CAS version.
func parseConversationPublicReference(value any) (Object, error) {
	ref := object(value)
	if ref == nil || !validOperationID(text(ref, "id")) {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	kind := text(ref, "kind")
	if kind != "post" && kind != "reply" {
		return nil, fail("invalid_operations_agentos_request", 400)
	}
	for key := range ref {
		if key != "kind" && key != "id" && (key != "versionId" || kind != "post") {
			return nil, fail("invalid_operations_agentos_request", 400)
		}
	}
	if version, present := ref["versionId"]; present {
		id, ok := version.(string)
		if !ok || !validOperationID(id) {
			return nil, fail("invalid_operations_agentos_request", 400)
		}
	}
	return copyObject(ref), nil
}

func checkConversationPublicReference(ref, args, current Object) error {
	if ref == nil {
		return nil
	}
	if ref["kind"] != args["kind"] || ref["id"] != args["id"] {
		return fail("invalid_operations_agentos_request", 400)
	}
	if version, present := ref["versionId"]; present && current["versionId"] != version {
		return fail("operations_agentos_source_changed", 409)
	}
	return nil
}

func conversationArgumentsDigest(args, reference Object) (string, error) {
	var value any = args
	if reference != nil {
		value = Object{"arguments": args, "publicReference": reference}
	}
	raw, err := identity.Canonical(value)
	if err != nil {
		return "", err
	}
	return identity.Digest(raw), nil
}
