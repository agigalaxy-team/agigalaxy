package native

import (
	"context"
	"os/exec"
	"syscall"
)

func navigationPlatformOpen(ctx context.Context, target string) (map[string]any, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	command := exec.Command("explorer.exe", target)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000008 | 0x00000200}
	if e := command.Start(); e != nil {
		return map[string]any{"state": "launch-failed", "launched": false}, nil
	}
	go command.Wait()
	return map[string]any{"state": "launch-requested", "launched": true}, nil
}
