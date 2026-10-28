package operationalmetrics

import (
	"bytes"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var backupActions = map[string]bool{"init": true, "create": true, "check": true, "copy": true, "retention": true, "restore": true, "prepare-cleanup": true, "cleanup": true}

type CostScope struct {
	Dimension   string `json:"dimension"`
	Count       int    `json:"count"`
	SHA256      string `json:"sha256"`
	Attribution string `json:"attribution"`
}
type CostInput struct {
	Version     int        `json:"version"`
	Currency    string     `json:"currency"`
	Kind        string     `json:"kind"`
	Amount      float64    `json:"amount"`
	Budget      *float64   `json:"budget"`
	PeriodStart string     `json:"periodStart"`
	PeriodEnd   string     `json:"periodEnd"`
	ObservedAt  string     `json:"observedAt"`
	Scope       *CostScope `json:"scope,omitempty"`
}
type BackupStatus struct {
	Version       int    `json:"version"`
	Action        string `json:"action"`
	RunID         string `json:"runId"`
	StartedAt     int64  `json:"startedAt"`
	FinishedAt    *int64 `json:"finishedAt"`
	Outcome       string `json:"outcome"`
	LastSuccessAt *int64 `json:"lastSuccessAt"`
}
type Configuration struct {
	Port                                              *int
	StorageDirectory, CostFile, BackupStatusDirectory string
	Cost                                              *CostInput
	MonitoredBackupActions                            []string
}

func invalid() error { return fault.New("metrics_configuration_invalid", 500) }
func readFile(path string) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, invalid()
	}
	info, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Size() > 8192 {
		return nil, invalid()
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	body, e := io.ReadAll(io.LimitReader(f, 8193))
	if e != nil || len(body) > 8192 {
		return nil, invalid()
	}
	return body, nil
}
func strict(body []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil || d.Decode(new(any)) != io.EOF {
		return invalid()
	}
	return nil
}
func date(value string) (time.Time, error) {
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$`).MatchString(value) {
		return time.Time{}, invalid()
	}
	return time.Parse(time.RFC3339Nano, value)
}
func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 }
func ReadCost(path string) (*CostInput, error) {
	body, e := readFile(path)
	if e != nil {
		return nil, invalid()
	}
	var value CostInput
	if strict(body, &value) != nil {
		return nil, invalid()
	}
	var fields map[string]json.RawMessage
	json.Unmarshal(body, &fields)
	if fields["amount"] == nil || bytes.Equal(fields["amount"], []byte("null")) || fields["budget"] == nil {
		return nil, invalid()
	}
	if value.Version == 1 && fields["scope"] != nil {
		return nil, invalid()
	}
	if e = validateCost(&value); e != nil {
		return nil, e
	}
	return &value, nil
}
func validateCost(v *CostInput) error {
	if v == nil {
		return nil
	}
	start, e := date(v.PeriodStart)
	end, e2 := date(v.PeriodEnd)
	_, e3 := date(v.ObservedAt)
	if e != nil || e2 != nil || e3 != nil || !start.Before(end) || !regexp.MustCompile(`^[A-Z]{3}$`).MatchString(v.Currency) || !oneOf(v.Kind, "billing-export", "operator-estimate") || !finite(v.Amount) || (v.Budget != nil && !finite(*v.Budget)) {
		return invalid()
	}
	if v.Version == 1 {
		if v.Budget == nil || v.Scope != nil {
			return invalid()
		}
	} else if v.Version == 2 {
		s := v.Scope
		if s == nil || !oneOf(s.Dimension, "compartmentId", "resourceId") || s.Count < 1 || s.Count > 100 || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(s.SHA256) || s.Attribution != "unallocated" {
			return invalid()
		}
	} else {
		return invalid()
	}
	return nil
}
func ReadBackupStatus(directory, action string) (*BackupStatus, error) {
	if !backupActions[action] || !filepath.IsAbs(directory) {
		return nil, invalid()
	}
	body, e := readFile(filepath.Join(directory, action+".json"))
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, invalid()
	}
	var value BackupStatus
	if strict(body, &value) != nil {
		return nil, invalid()
	}
	var fields map[string]json.RawMessage
	json.Unmarshal(body, &fields)
	if len(fields) != 7 || value.Version != 1 || value.Action != action || uuid.Validate(value.RunID) != nil || (value.StartedAt < 0 || value.StartedAt > 9007199254740991 || bytes.Equal(fields["startedAt"], []byte("null"))) || (value.FinishedAt != nil && (*value.FinishedAt < 0 || *value.FinishedAt > 9007199254740991)) || (value.LastSuccessAt != nil && (*value.LastSuccessAt < 0 || *value.LastSuccessAt > 9007199254740991)) || !oneOf(value.Outcome, "running", "succeeded", "failed") || (value.Outcome == "running") != (value.FinishedAt == nil) {
		return nil, invalid()
	}
	return &value, nil
}
func oneOf(v string, values ...string) bool {
	for _, value := range values {
		if v == value {
			return true
		}
	}
	return false
}
func LoadConfiguration(env func(string) (string, bool)) (Configuration, error) {
	c := Configuration{MonitoredBackupActions: []string{"create", "check", "copy"}}
	if v, ok := env("GALAXY_METRICS_PORT"); ok {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1024 || n > 65535 {
			return c, invalid()
		}
		c.Port = &n
	}
	for key, target := range map[string]*string{"GALAXY_METRICS_STORAGE_DIRECTORY": &c.StorageDirectory, "GALAXY_METRICS_COST_FILE": &c.CostFile, "GALAXY_BACKUP_STATUS_DIRECTORY": &c.BackupStatusDirectory} {
		if value, ok := env(key); ok {
			if !filepath.IsAbs(value) {
				return c, invalid()
			}
			*target = value
		}
	}
	if c.CostFile != "" {
		cost, e := ReadCost(c.CostFile)
		if e != nil {
			return c, e
		}
		c.Cost = cost
	}
	if v, ok := env("GALAXY_METRICS_BACKUP_ACTIONS"); ok {
		c.MonitoredBackupActions = strings.Split(v, ",")
	}
	seen := map[string]bool{}
	for _, action := range c.MonitoredBackupActions {
		if !backupActions[action] || seen[action] {
			return c, invalid()
		}
		seen[action] = true
	}
	return c, nil
}
