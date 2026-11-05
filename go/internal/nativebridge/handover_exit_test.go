package nativebridge

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestHandoverExitTransient(t *testing.T) {
	for _, err := range []error{io.EOF, io.ErrUnexpectedEOF, net.ErrClosed, fmt.Errorf("wrapped: %w", io.EOF)} {
		if !handoverExitTransient(err) {
			t.Errorf("closed transport not recognized: %v", err)
		}
	}
	for _, err := range []error{nil, os.ErrPermission, errors.New("malformed response"), fault.New("native_service_protocol_mismatch", 409)} {
		if handoverExitTransient(err) {
			t.Errorf("non-transport error treated as exit: %v", err)
		}
	}
}
