//go:build !windows

package nativebridge

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"syscall"
)

func secureDirectory(dir string) error {
	st, e := os.Lstat(dir)
	if e != nil {
		return e
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return errors.New("invalid native service directory")
	}
	stat, ok := st.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return errors.New("native service directory owner mismatch")
	}
	return os.Chmod(dir, 0700)
}
func endpoint(dir string) string { return dir + "/service.sock" }
func listen(ep string) (net.Listener, error) {
	if e := os.Remove(ep); e != nil && !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	return net.Listen("unix", ep)
}
func cleanupEndpoint(ep string) { _ = os.Remove(ep) }
func dial(ctx context.Context, ep string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", ep)
}
func startDaemon(exe string) error {
	c := exec.Command(exe, "native-service")
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	c.Stdin = nil
	c.Stdout = nil
	c.Stderr = nil
	if e := c.Start(); e != nil {
		return e
	}
	return c.Process.Release()
}

func isUnavailable(err error) bool {
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED)
}
