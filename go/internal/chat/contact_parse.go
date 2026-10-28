package chat

// ParseContactEvent is the original unsigned input parser for trusted host
// adapters. Already signed payload text must retain its original bytes.
func ParseContactEvent(raw []byte) (Object, error) { return parseContactEvent(raw) }
