package access

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPublicAndPrivateConfigurationFileModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file mode boundary")
	}
	file := filepath.Join(t.TempDir(), "configuration.json")
	if e := os.WriteFile(file, []byte(`{"version":1}`), 0600); e != nil {
		t.Fatal(e)
	}
	for _, test := range []struct {
		name            string
		mode            os.FileMode
		public, private bool
	}{
		{"public-metadata", 0644, true, false},
		{"private-configuration", 0640, true, true},
		{"group-writable-metadata", 0664, false, false},
		{"world-writable", 0666, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if e := os.Chmod(file, test.mode); e != nil {
				t.Fatal(e)
			}
			var value map[string]any
			if got := publicJSON(file, 4096, &value) == nil; got != test.public {
				t.Fatalf("public accepted=%v", got)
			}
			if got := protectedJSON(file, 4096, &value) == nil; got != test.private {
				t.Fatalf("private accepted=%v", got)
			}
		})
	}
	if e := os.Chmod(file, 0644); e != nil {
		t.Fatal(e)
	}
	var value map[string]any
	if publicJSON(file, 2, &value) == nil {
		t.Fatal("oversize public configuration accepted")
	}
	link := filepath.Join(filepath.Dir(file), "link.json")
	if e := os.Symlink(file, link); e != nil {
		t.Fatal(e)
	}
	if publicJSON(link, 4096, &value) == nil {
		t.Fatal("public configuration symlink accepted")
	}
}
