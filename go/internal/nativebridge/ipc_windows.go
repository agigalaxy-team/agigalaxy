//go:build windows

package nativebridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"os/exec"
	"syscall"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func userSID() (string, error) {
	user, e := windows.GetCurrentProcessToken().GetTokenUser()
	if e != nil {
		return "", e
	}
	return user.User.Sid.String(), nil
}
func secureDirectory(dir string) error {
	st, e := os.Lstat(dir)
	if e != nil {
		return e
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return errors.New("invalid native service directory")
	}
	return nil
}
func endpoint(dir string) string {
	sid, _ := userSID()
	sum := sha256.Sum256([]byte(sid + "|" + dir))
	return `\\.\pipe\galaxy-native-` + hex.EncodeToString(sum[:16])
}
func listen(ep string) (net.Listener, error) {
	sid, e := userSID()
	if e != nil {
		return nil, e
	}
	return winio.ListenPipe(ep, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + sid + ")", MessageMode: false, InputBufferSize: 65536, OutputBufferSize: 65536})
}
func cleanupEndpoint(string)                                {}
func dial(ctx context.Context, ep string) (net.Conn, error) { return winio.DialPipeContext(ctx, ep) }
func startDaemon(exe string) error {
	c := exec.Command(exe, "native-service")
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000 | 0x00000200, HideWindow: true}
	if e := c.Start(); e != nil {
		return e
	}
	return c.Process.Release()
}

func isUnavailable(err error) bool {
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}
