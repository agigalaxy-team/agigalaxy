//go:build linux

package nativebridge

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

func loginctl(ctx context.Context, args ...string) (string, error) {
	query, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	command := exec.CommandContext(query, "loginctl", args...)
	command.Env = append(os.Environ(), "LC_ALL=C")
	raw, err := command.Output()
	return strings.TrimSpace(string(raw)), err
}

func WatchLoginSession(ctx context.Context, onEnd context.CancelFunc) (LoginSession, error) {
	id := os.Getenv("XDG_SESSION_ID")
	if id == "" {
		var err error
		id, err = loginctl(ctx, "show-session", "self", "--property=Id", "--value", "--no-pager")
		if err != nil || id == "" {
			return LoginSession{}, errors.New("native_login_session_unavailable")
		}
	}
	if strings.ContainsAny(id, "\x00\r\n\t ") || strings.HasPrefix(id, "-") {
		return LoginSession{}, errors.New("native_login_session_unavailable")
	}
	if _, err := loginctl(ctx, "show-session", id, "--property=State", "--value", "--no-pager"); err != nil {
		return LoginSession{}, errors.New("native_login_session_unavailable")
	}
	go func() {
		tick := time.NewTicker(3 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
			state, err := loginctl(ctx, "show-session", id, "--property=State", "--value", "--no-pager")
			if err == nil {
				if state == "closing" {
					onEnd()
					return
				}
				continue
			}
			// A command/DBus failure alone is not logout. Confirm removal by a
			// successful session inventory before ending this login's runtime.
			list, err := loginctl(ctx, "list-sessions", "--no-legend", "--no-pager")
			if err != nil {
				continue
			}
			found := false
			for _, line := range strings.Split(list, "\n") {
				fields := strings.Fields(line)
				if len(fields) > 0 && fields[0] == id {
					found = true
					break
				}
			}
			if !found {
				onEnd()
				return
			}
		}
	}()
	return LoginSession{Kind: "logind", ID: id}, nil
}
