package nativebridge

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/gofrs/flock"
)

type DesiredRelease struct {
	Executable string `json:"executable"`
	ReleaseID  string `json:"releaseId"`
}

// SetDesiredRelease records an already prepared complete release as the next
// on-demand service executable; it does not stop the currently running core.
func SetDesiredRelease(executable string) (DesiredRelease, error) {
	d, _, err := SelectDesiredRelease(executable, true)
	return d, err
}

// SelectDesiredRelease atomically selects the prepared release. When replace
// is false an existing selection wins, preventing repair of another host from
// silently rolling back a newer selection. The bool reports an actual write.
func SelectDesiredRelease(executable string, replace bool) (DesiredRelease, bool, error) {
	var d DesiredRelease
	if !filepath.IsAbs(executable) {
		return d, false, fault.New("native_release_path_invalid", 400)
	}
	executable = filepath.Clean(executable)
	st, err := os.Stat(executable)
	if err != nil {
		return d, false, err
	}
	if !st.Mode().IsRegular() {
		return d, false, fault.New("native_release_path_invalid", 400)
	}
	id := releaseID(executable)
	if id == "" {
		return d, false, fault.New("native_release_manifest_invalid", 400)
	}
	dir, _, _, err := paths()
	if err != nil {
		return d, false, err
	}
	lock := flock.New(filepath.Join(dir, "desired-release.lock"))
	if err = lock.Lock(); err != nil {
		return d, false, err
	}
	defer lock.Unlock()
	current, err := GetDesiredRelease()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return d, false, err
	}
	if err == nil && (!replace || current.ReleaseID == id && sameReleaseExecutable(current.Executable, executable)) {
		return current, false, nil
	}
	d = DesiredRelease{Executable: executable, ReleaseID: id}
	data, err := json.Marshal(d)
	if err != nil {
		return d, false, err
	}
	data = append(data, '\n')
	f, err := os.CreateTemp(dir, ".desired-*.tmp")
	if err != nil {
		return d, false, err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return d, false, err
	}
	if closeErr != nil {
		return d, false, closeErr
	}
	if err = os.Rename(name, filepath.Join(dir, "desired-release.json")); err != nil {
		return d, false, err
	}
	return d, true, nil
}

// GetDesiredRelease returns os.ErrNotExist when no managed release was set.
func GetDesiredRelease() (DesiredRelease, error) {
	var d DesiredRelease
	dir, _, _, e := paths()
	if e != nil {
		return d, e
	}
	data, e := os.ReadFile(filepath.Join(dir, "desired-release.json"))
	if e != nil {
		return d, e
	}
	if len(data) > 65536 || json.Unmarshal(data, &d) != nil || !filepath.IsAbs(d.Executable) || d.ReleaseID == "" {
		return d, fault.New("native_release_pointer_invalid", 409)
	}
	return d, nil
}
func selectedExecutable(fallback string) (string, error) {
	d, e := GetDesiredRelease()
	if errors.Is(e, os.ErrNotExist) {
		return fallback, nil
	}
	if e != nil {
		return "", e
	}
	st, e := os.Stat(d.Executable)
	if e != nil || !st.Mode().IsRegular() || releaseID(d.Executable) != d.ReleaseID {
		return "", fault.New("native_release_pointer_unavailable", 409)
	}
	return d.Executable, nil
}
func decorateRelease(info Info) (Info, error) {
	d, e := GetDesiredRelease()
	if errors.Is(e, os.ErrNotExist) {
		return info, nil
	}
	if e != nil {
		info.SwitchState = "unavailable"
		info.ReleaseIssue = fault.Code(e)
		return info, nil
	}
	st, statErr := os.Stat(d.Executable)
	if statErr != nil || !st.Mode().IsRegular() || releaseID(d.Executable) != d.ReleaseID {
		info.SwitchState = "unavailable"
		info.ReleaseIssue = "native_release_pointer_unavailable"
		return info, nil
	}
	info.InstalledReleaseID = d.ReleaseID
	info.InstalledExecutable = d.Executable
	if info.ReleaseID != "" && info.ReleaseID == d.ReleaseID && sameReleaseExecutable(info.Executable, d.Executable) {
		info.SwitchState = "current"
	} else {
		info.PendingReleaseID = d.ReleaseID
		info.PendingExecutable = d.Executable
		info.SwitchState = "restart-required"
	}
	return info, nil
}

func releaseID(executable string) string {
	if executable == "" {
		return ""
	}
	data, e := os.ReadFile(filepath.Join(filepath.Dir(executable), "native-v2.json"))
	if e != nil || len(data) > 1024*1024 {
		return ""
	}
	var manifest struct {
		ReleaseID string `json:"releaseId"`
	}
	if json.Unmarshal(data, &manifest) != nil {
		return ""
	}
	return manifest.ReleaseID
}

func sameReleaseExecutable(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
