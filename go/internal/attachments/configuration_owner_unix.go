//go:build unix

package attachments

import (
	"os"
	"syscall"
)

func ownedByRuntime(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && (stat.Uid == 0 || stat.Uid == uint32(os.Getuid()))
}
