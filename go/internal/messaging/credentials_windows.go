//go:build windows

package messaging

import (
	"os"
)

func rootOwned(os.FileInfo) bool { return true }
