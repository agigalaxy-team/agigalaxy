package nativebridge

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type DesiredRelease struct {
	Executable string `json:"executable"`
	ReleaseID  string `json:"releaseId"`
}

// SetDesiredRelease records an already prepared complete release as the next
// on-demand service executable; it does not stop the currently running core.
func SetDesiredRelease(executable string) (DesiredRelease, error) {
	var d DesiredRelease
	if !filepath.IsAbs(executable) {
		return d, fault.New("native_release_path_invalid", 400)
	}
	executable = filepath.Clean(executable)
	st, e := os.Stat(executable)
	if e != nil {
		return d, e
	}
	if !st.Mode().IsRegular() {
		return d, fault.New("native_release_path_invalid", 400)
	}
	id := releaseID(executable)
	if id == "" {
		return d, fault.New("native_release_manifest_invalid", 400)
	}
	dir, _, _, e := paths()
	if e != nil {
		return d, e
	}
	d = DesiredRelease{Executable: executable, ReleaseID: id}
	data, e := json.Marshal(d)
	if e != nil {
		return d, e
	}
	data = append(data, '\n')
	f, e := os.CreateTemp(dir, ".desired-*.tmp")
	if e != nil {
		return d, e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(data)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return d, e
	}
	if closeErr != nil {
		return d, closeErr
	}
	if e = os.Rename(name, filepath.Join(dir, "desired-release.json")); e != nil {
		return d, e
	}
	return d, nil
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
	if info.ReleaseID != "" && info.ReleaseID == d.ReleaseID && filepath.Clean(info.Executable) == filepath.Clean(d.Executable) {
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
