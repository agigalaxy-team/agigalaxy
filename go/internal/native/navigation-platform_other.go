//go:build !windows

package native

import (
	"context"
	"os/exec"
	"runtime"
	"syscall"
)

func navigationPlatformOpen(ctx context.Context, target string) (map[string]any, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	command := exec.Command(name, target)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if e := command.Start(); e != nil {
		return map[string]any{"state": "launch-failed", "launched": false}, nil
	}
	go command.Wait()
	return map[string]any{"state": "launch-requested", "launched": true}, nil
}
