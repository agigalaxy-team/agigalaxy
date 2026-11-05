//go:build windows

package nativebridge

import (
	"golang.org/x/sys/windows"
	"testing"
)

func TestHandoverExitWindowsPipeErrors(t *testing.T) {
	for _, err := range []error{windows.ERROR_BROKEN_PIPE, windows.ERROR_PIPE_NOT_CONNECTED, windows.ERROR_NO_DATA} {
		if !handoverExitTransient(err) {
			t.Errorf("closed pipe not recognized: %v", err)
		}
	}
	if handoverExitTransient(windows.ERROR_ACCESS_DENIED) {
		t.Error("access denied treated as exit")
	}
}
