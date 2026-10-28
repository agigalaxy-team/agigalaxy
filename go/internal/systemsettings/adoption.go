package systemsettings

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"time"
)

// ActualConnection is bound by startup to the clients which were successfully
// constructed. Submitted metadata supplies only the existing public locator.
type ActualConnection func(context.Context, string, string) (Object, *bool, error)
type AdoptionOptions struct {
	PID          int
	Now          func() time.Time
	ReadMetadata func(string, int64) (Object, error)
	WriteReceipt func(string, Object) error
}

var ServiceConnectionReceiptFiles = map[string]string{"api": "/var/log/galaxy/pilot/api/service-connections-adopted.json", "worker": "/var/log/galaxy/pilot/worker/service-connections-adopted.json"}
var OperationsMailReceiptFiles = map[string]string{"api": "/var/log/galaxy/pilot/api/operations-mail-adopted.json", "worker": "/var/log/galaxy/pilot/worker/operations-mail-adopted.json"}

func owner(info os.FileInfo) (uint64, bool) {
	v := reflect.ValueOf(info.Sys())
	if v.Kind() == reflect.Pointer {
		v = v.Elem()
	}
	if !v.IsValid() || v.Kind() != reflect.Struct {
		return 0, false
	}
	v = v.FieldByName("Uid")
	if !v.IsValid() || !v.CanUint() {
		return 0, false
	}
	return v.Uint(), true
}
func readMetadata(file string, max int64) (Object, error) {
	bad := func() (Object, error) { return nil, fail("system_settings_private_configuration_invalid", 503) }
	if !filepath.IsAbs(file) {
		return bad()
	}
	before, e := os.Lstat(file)
	if e != nil || !before.Mode().IsRegular() || before.Size() > max {
		return bad()
	}
	if runtime.GOOS != "windows" {
		uid, ok := owner(before)
		if !ok || uid != 0 || before.Mode().Perm()&0022 != 0 {
			return bad()
		}
	}
	f, e := os.Open(file)
	if e != nil {
		return bad()
	}
	defer f.Close()
	opened, e := f.Stat()
	if e != nil || !os.SameFile(before, opened) {
		return bad()
	}
	b, e := io.ReadAll(io.LimitReader(f, max+1))
	if e != nil || int64(len(b)) > max {
		return bad()
	}
	after, e := f.Stat()
	if e != nil || after.Size() != int64(len(b)) || !after.ModTime().Equal(opened.ModTime()) {
		return bad()
	}
	var out Object
	if protocol.Decode(b, &out) != nil {
		return bad()
	}
	return out, nil
}
func writeReceipt(file string, value Object) error {
	bad := func() error { return fail("system_settings_adoption_unconfirmed", 503) }
	parent, e := os.Lstat(filepath.Dir(file))
	if e != nil || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 {
		return bad()
	}
	if old, e := os.Lstat(file); e == nil {
		if !old.Mode().IsRegular() {
			return bad()
		}
		if runtime.GOOS != "windows" {
			uid, ok := owner(old)
			if !ok || uid != uint64(os.Getuid()) || old.Mode().Perm()&0077 != 0 {
				return bad()
			}
		}
	} else if !os.IsNotExist(e) {
		return bad()
	}
	b, e := protocol.EncodeJS(value)
	if e != nil {
		return bad()
	}
	temp, e := os.CreateTemp(filepath.Dir(file), filepath.Base(file)+".*.tmp")
	if e != nil {
		return bad()
	}
	name := temp.Name()
	defer os.Remove(name)
	if _, e = temp.Write(append(b, '\n')); e != nil {
		temp.Close()
		return bad()
	}
	if e = temp.Close(); e != nil {
		return bad()
	}
	if e = os.Rename(name, file); e != nil {
		return bad()
	}
	return nil
}
func (o AdoptionOptions) pid() int {
	if o.PID > 0 {
		return o.PID
	}
	return os.Getpid()
}
func (o AdoptionOptions) at() int64 {
	if o.Now != nil {
		return o.Now().Unix()
	}
	return time.Now().Unix()
}
func (o AdoptionOptions) read(file string, max int64) (Object, error) {
	if o.ReadMetadata != nil {
		return o.ReadMetadata(file, max)
	}
	return readMetadata(file, max)
}
func (o AdoptionOptions) write(file string, value Object) error {
	if o.WriteReceipt != nil {
		return o.WriteReceipt(file, value)
	}
	return writeReceipt(file, value)
}
func ParseServiceReadback(input Object) (Object, error) {
	if !closed(input, []string{"component", "versionId", "pid", "checkedAt", "connections"}, nil) || !includes([]string{"api", "worker"}, str(input["component"])) || !whole(input["pid"], 1, 9007199254740991) || !whole(input["checkedAt"], 0, 9007199254740991) {
		return nil, invalid()
	}
	if _, ok := parseUUID(input["versionId"], false); !ok {
		return nil, invalid()
	}
	rows, ok := input["connections"].([]any)
	if !ok || len(rows) > 5 {
		return nil, invalid()
	}
	normalized := []any{}
	for _, v := range rows {
		r := obj(v)
		if !closed(r, []string{"configuration", "credentialsConfigured"}, nil) {
			return nil, invalid()
		}
		configuration, e := ParseServiceBinding(obj(r["configuration"]), true)
		if e != nil {
			return nil, e
		}
		if r["credentialsConfigured"] != nil {
			if _, ok := r["credentialsConfigured"].(bool); !ok {
				return nil, invalid()
			}
		}
		normalized = append(normalized, Object{"configuration": configuration, "credentialsConfigured": r["credentialsConfigured"]})
	}
	out := clone(input)
	out["connections"] = normalized
	return out, nil
}
func CreateServiceConnectionReadback(ctx context.Context, component, versionID string, connections []any, actual ActualConnection, o AdoptionOptions) (Object, error) {
	if !includes([]string{"api", "worker"}, component) {
		return nil, fail("system_settings_consumer_not_configured", 503)
	}
	rows := []any{}
	for _, v := range connections {
		configuration, e := ParseServiceBinding(obj(v), true)
		if e != nil {
			return nil, e
		}
		kind, id := str(configuration["kind"]), str(configuration["id"])
		if component == "worker" && kind == "ai-execution" {
			continue
		}
		if actual == nil {
			continue
		}
		binding, configured, e := actual(ctx, kind, id)
		if e != nil {
			return nil, e
		}
		if binding == nil {
			continue
		}
		observed := clone(binding)
		if kind != "file-scanning" {
			observed["credentialRef"] = configuration["credentialRef"]
		}
		parsed, e := ParseServiceBinding(observed, true)
		if e != nil {
			continue
		}
		var credentials any
		if kind != "file-scanning" {
			credentials = configured != nil && *configured
		}
		rows = append(rows, Object{"configuration": parsed, "credentialsConfigured": credentials})
	}
	return ParseServiceReadback(Object{"component": component, "versionId": versionID, "pid": o.pid(), "checkedAt": o.at(), "connections": rows})
}
func LoadServiceConnectionReadback(ctx context.Context, file, component string, actual ActualConnection, o AdoptionOptions) (Object, error) {
	if file == "" {
		return nil, nil
	}
	if !filepath.IsAbs(file) {
		return nil, fail("system_settings_consumer_not_configured", 503)
	}
	metadata, e := o.read(file, 65536)
	if e != nil {
		return nil, e
	}
	if !closed(metadata, []string{"version", "versionId", "connections"}, nil) || !whole(metadata["version"], 1, 1) {
		return nil, invalid()
	}
	if _, ok := parseUUID(metadata["versionId"], false); !ok {
		return nil, invalid()
	}
	parsed, e := ParseConfiguration("service-connections", Object{"connections": metadata["connections"]})
	if e != nil {
		return nil, e
	}
	return CreateServiceConnectionReadback(ctx, component, str(metadata["versionId"]), list(parsed["connections"]), actual, o)
}
func ReportServiceConnectionAdoption(ctx context.Context, file, component string, actual ActualConnection, o AdoptionOptions) Object {
	if file == "" {
		return Object{"state": "not-configured"}
	}
	receipt, e := LoadServiceConnectionReadback(ctx, file, component, actual, o)
	if e == nil && ServiceConnectionReceiptFiles[component] != "" {
		e = o.write(ServiceConnectionReceiptFiles[component], receipt)
	} else if e == nil {
		e = invalid()
	}
	if e != nil {
		return Object{"state": "unavailable", "code": "system_settings_adoption_unconfirmed"}
	}
	return Object{"state": "recorded", "component": receipt["component"], "versionId": receipt["versionId"]}
}
func ServiceConnectionTargets(configuration Object) []string {
	if configuration["kind"] == "ai-execution" {
		return []string{"api"}
	}
	return []string{"api", "worker"}
}
func ServiceConnectionMatches(left, right Object) bool {
	a, e := ParseServiceBinding(left, true)
	b, f := ParseServiceBinding(right, true)
	if e != nil || f != nil {
		return false
	}
	delete(a, "credentialRef")
	delete(b, "credentialRef")
	return same(a, b)
}
func ServiceConnectionAdopted(observation, configuration Object, versionID, component string, pid int) bool {
	value, e := ParseServiceReadback(observation)
	if e != nil || value["component"] != component || value["versionId"] != versionID || num(value["pid"]) != int64(pid) {
		return false
	}
	matches := []Object{}
	for _, v := range list(value["connections"]) {
		r := obj(v)
		c := obj(r["configuration"])
		if c["id"] == configuration["id"] && c["kind"] == configuration["kind"] {
			matches = append(matches, r)
		}
	}
	return len(matches) == 1 && ServiceConnectionMatches(obj(matches[0]["configuration"]), configuration) && (configuration["kind"] == "file-scanning" || matches[0]["credentialsConfigured"] == true)
}
func ReportOperationsMailAdoption(ctx context.Context, file, component string, smtp *messaging.SMTPService, credentialFile string, o AdoptionOptions) Object {
	if file == "" {
		return Object{"state": "not-configured"}
	}
	unavailable := func() Object { return Object{"state": "unavailable", "code": "system_settings_adoption_unconfirmed"} }
	if !filepath.IsAbs(file) || !filepath.IsAbs(credentialFile) || OperationsMailReceiptFiles[component] == "" || smtp == nil {
		return unavailable()
	}
	metadata, e := o.read(file, 32768)
	if e != nil || !closed(metadata, []string{"version", "versionId", "connection"}, nil) || !whole(metadata["version"], 1, 1) {
		return unavailable()
	}
	if _, ok := parseUUID(metadata["versionId"], false); !ok {
		return unavailable()
	}
	configuration, e := OperationsMailConfiguration(obj(metadata["connection"]))
	if e != nil {
		return unavailable()
	}
	current, e := smtp.CurrentWithin(ctx, smtp.Pool)
	if e != nil {
		return unavailable()
	}
	status := smtp.StatusOf(current)
	if !same(current["configuration"], configuration) || status["credentialAvailable"] != true || !whole(current["version"], 0, 9007199254740991) {
		return unavailable()
	}
	receipt := Object{"version": 1, "versionId": metadata["versionId"], "component": component, "pid": o.pid(), "checkedAt": o.at(), "configurationVersion": current["version"], "configuration": current["configuration"], "credentialConfigured": true, "credentialFile": credentialFile}
	if e = o.write(OperationsMailReceiptFiles[component], receipt); e != nil {
		return unavailable()
	}
	return Object{"state": "recorded", "versionId": metadata["versionId"]}
}

func DescribeServiceConnections(connections, current []any, checkedAt int64) (Object, error) {
	items := []any{}
	for _, v := range connections {
		configuration, e := ParseServiceBinding(obj(v), true)
		if e != nil {
			return nil, e
		}
		var matches []Object
		for _, v := range current {
			r := obj(v)
			if r["id"] == configuration["id"] && r["kind"] == configuration["kind"] {
				matches = append(matches, r)
			}
		}
		var row Object
		if len(matches) == 1 {
			row = matches[0]
		}
		var configured any
		if configuration["kind"] != "file-scanning" {
			configured = row["credentialConfigured"] == true
		}
		state := "unknown"
		if row["state"] == "available" || row["state"] == "unavailable" {
			state = str(row["state"])
		}
		items = append(items, Object{"id": configuration["id"], "kind": configuration["kind"], "configuration": configuration, "credentialConfigured": configured, "appliedVersionId": row["appliedVersionId"], "state": state})
	}
	return Object{"checkedAt": checkedAt, "items": items}, nil
}
