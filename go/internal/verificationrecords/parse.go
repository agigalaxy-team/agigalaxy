package verificationrecords

// ParseEvent is the shared original event schema refinement for the Native
// caller and server. It validates/normalizes fields only; callers retain the
// original raw bytes for Consent, operation hashing and transmission.
func ParseEvent(raw []byte) (Object, error) { return parseRecord(string(raw)) }
