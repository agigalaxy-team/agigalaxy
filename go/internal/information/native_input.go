package information

// ParseWatchRequest shares the current watch input parser with Native transport.
func ParseWatchRequest(raw []byte, kind string) (Object, error) { return parseWatch(raw, kind) }
