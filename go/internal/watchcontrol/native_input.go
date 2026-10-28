package watchcontrol

import "github.com/agigalaxy-team/agigalaxy/go/internal/protocol"

// ParseRequest retains the original schema member order used by request hashes.
func ParseRequest(raw []byte, kind string) (*protocol.OrderedObject, error) { return parse(raw, kind) }
