//go:build linux || darwin

package operationalmetrics

import (
	"golang.org/x/sys/unix"
)

func diskSpace(path string) (total, available uint64, err error) {
	var stat unix.Statfs_t
	err = unix.Statfs(path, &stat)
	if err == nil {
		total = uint64(stat.Blocks) * uint64(stat.Bsize)
		available = uint64(stat.Bavail) * uint64(stat.Bsize)
	}
	return
}
