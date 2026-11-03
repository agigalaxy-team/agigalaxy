package nativebridge

// LoginSession describes an observed OS login boundary, not a host connection.
// An unavailable boundary is reported by the caller; it never installs an OS
// service, changes linger settings, or prevents container/foreground use.
type LoginSession struct {
	Kind string `json:"kind"`
	ID   string `json:"id,omitempty"`
}
