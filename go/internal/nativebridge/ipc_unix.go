//go:build !windows

package nativebridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
func endpoint(dir string) (string, error) {
	limit := len(syscall.RawSockaddrUnix{}.Path) - 1
	original := filepath.Join(dir, "service.sock")
	if len([]byte(original)) <= limit {
		return original, nil
	}
	canonical, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	tempRoot, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		return "", err
	}
	uid := strconv.Itoa(os.Getuid())
	sum := sha256.Sum256([]byte(uid + "\x00" + canonical))
	private := filepath.Join(tempRoot, "galaxy-native-"+uid+"-"+hex.EncodeToString(sum[:16]))
	if err = os.Mkdir(private, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	if err = secureDirectory(private); err != nil {
		return "", err
	}
	ep := filepath.Join(private, "service.sock")
	if len([]byte(ep)) > limit {
		return "", fmt.Errorf("native service socket path exceeds platform limit: %s", ep)
	}
	return ep, nil
}

// Only a socket owned by this user may be connected or removed. In particular,
// a symlink or ordinary file at this path is never followed or deleted.
func validateSocket(ep string) error {
	st, err := os.Lstat(ep)
	if err != nil {
		return err
	}
	stat, ok := st.Sys().(*syscall.Stat_t)
	if st.Mode()&os.ModeSocket == 0 || !ok || stat.Uid != uint32(os.Getuid()) {
		return errors.New("invalid native service socket owner or type")
	}
	return nil
}
func listen(ep string) (net.Listener, error) {
	if e := validateSocket(ep); e == nil {
		if e = os.Remove(ep); e != nil {
			return nil, e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	return net.Listen("unix", ep)
}
func cleanupEndpoint(ep string) {
	if validateSocket(ep) == nil {
		_ = os.Remove(ep)
	}
}
func dial(ctx context.Context, ep string) (net.Conn, error) {
	if e := validateSocket(ep); e != nil {
		return nil, e
	}
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

func handoverExitPlatformError(err error) bool {
	return errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE)
}
