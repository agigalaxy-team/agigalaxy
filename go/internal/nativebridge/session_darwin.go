//go:build darwin

package nativebridge

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var loginASID = regexp.MustCompile(`(?m)^\s*asid = ([0-9]+)\s*$`)

func launchDomain(ctx context.Context, domain string) (string, error) {
	query, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(query, "/bin/launchctl", "print", domain).CombinedOutput()
	return string(raw), err
}

func WatchLoginSession(ctx context.Context, onEnd context.CancelFunc) (LoginSession, error) {
	// Use the immutable audit-session ID rather than gui/<uid>, which can
	// name a later login after logout. Fast user switching keeps the domain.
	raw, err := launchDomain(ctx, "gui/"+strconv.Itoa(os.Getuid()))
	if err != nil {
		return LoginSession{}, errors.New("native_login_session_unavailable")
	}
	match := loginASID.FindStringSubmatch(raw)
	if len(match) != 2 {
		return LoginSession{}, errors.New("native_login_session_unavailable")
	}
	domain := "login/" + match[1]
	if _, err = launchDomain(ctx, domain); err != nil {
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
			output, err := launchDomain(ctx, domain)
			if err == nil {
				continue
			}
			// Only launchctl's explicit absent-domain answer ends a session;
			// a timeout or command failure does not become a false logout.
			if strings.Contains(output, "Could not find domain") || strings.Contains(output, "Could not find specified domain") {
				onEnd()
				return
			}
		}
	}()
	return LoginSession{Kind: "launchd-login", ID: match[1]}, nil
}
