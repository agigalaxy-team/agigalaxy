package recruitment

// ParseQuery shares the existing context normalization and discover refinement.
func ParseQuery(raw []byte) (Object, error) { return parseQuery(raw) }
