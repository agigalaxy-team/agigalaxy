//go:build windows

package operationalmetrics

import (
	"golang.org/x/sys/windows"
)

func diskSpace(path string) (total, available uint64, err error) {
	name, e := windows.UTF16PtrFromString(path)
	if e != nil {
		return 0, 0, e
	}
	var free uint64
	err = windows.GetDiskFreeSpaceEx(name, &available, &total, &free)
	return
}
