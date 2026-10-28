package trustpackages

// ParseIdentity shares the existing portable identity document schema. Chain
// verification remains the separate VerifyPortableIdentity operation.
func ParseIdentity(input Object) (Object, error) {
	if !identityDocument(input) {
		return nil, fail("invalid_trust_input", 422)
	}
	return input, nil
}
