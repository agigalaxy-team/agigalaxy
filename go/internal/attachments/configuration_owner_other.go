//go:build !unix

package attachments

import "os"

func ownedByRuntime(os.FileInfo) bool { return false }
