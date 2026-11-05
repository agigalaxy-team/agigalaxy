//go:build !windows

package nativebridge

import (
	"syscall"
	"testing"
)

func TestHandoverExitUnixSocketErrors(t *testing.T) {
	for _, err := range []error{syscall.ECONNRESET, syscall.EPIPE} {
		if !handoverExitTransient(err) {
			t.Errorf("closed socket not recognized: %v", err)
		}
	}
	if handoverExitTransient(syscall.EACCES) {
		t.Error("access denied treated as exit")
	}
}
