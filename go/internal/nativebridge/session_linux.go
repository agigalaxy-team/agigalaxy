//go:build linux

package nativebridge

import "context"

// A short-lived launcher session is not the shared service's lifetime. The
// service manager or operating system owns that boundary on Linux.
func WatchLoginSession(context.Context, context.CancelFunc) (LoginSession, error) {
	if linuxTransientBootstrap {
		return LoginSession{Kind: "systemd-transient"}, nil
	}
	return LoginSession{Kind: "environment-managed"}, nil
}
