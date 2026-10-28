package contextdata

// ParseHelpPayload reuses the existing v2 payload parser without changing its
// original signed bytes or turning local selection into authorization.
func ParseHelpPayload(kind, raw string) (Object, error) {
	var o *ordered
	var e error
	if kind == "context-grant" {
		o, e = parseGrant(raw, true)
	} else {
		o, e = parseEvent(raw, true)
	}
	if e != nil {
		return nil, e
	}
	return o.Values(), nil
}
