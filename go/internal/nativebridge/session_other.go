//go:build !windows && !linux && !darwin

package nativebridge

import (
	"context"
	"errors"
)

func WatchLoginSession(context.Context, context.CancelFunc) (LoginSession, error) {
	return LoginSession{}, errors.New("native_login_session_unavailable")
}
