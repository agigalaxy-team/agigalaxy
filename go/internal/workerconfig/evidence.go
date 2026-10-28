package workerconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

var policyRef = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var evidenceHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

type retirementPolicy struct {
	Version           int    `json:"version"`
	ID                string `json:"id"`
	Endpoint          string `json:"endpoint"`
	Operator          string `json:"operator"`
	Reason            string `json:"reason"`
	AnnouncedAt       int64  `json:"announcedAt"`
	StopWritesAt      int64  `json:"stopWritesAt"`
	TakeoutUntil      int64  `json:"takeoutUntil"`
	StatusUntil       int64  `json:"statusUntil"`
	ContactURL        string `json:"contactUrl"`
	DeletionPolicyURL string `json:"deletionPolicyUrl"`
}
type incidentPolicy struct {
	Version       int    `json:"version"`
	ID            string `json:"id"`
	Revision      int64  `json:"revision"`
	Endpoint      string `json:"endpoint"`
	State         string `json:"state"`
	UpdatedAt     int64  `json:"updatedAt"`
	PublicMessage string `json:"publicMessage"`
	Recovery      *struct {
		CheckedAt      int64  `json:"checkedAt"`
		EvidenceSHA256 string `json:"evidenceSha256"`
	} `json:"recovery,omitempty"`
}

func publicURL(value string, origin bool) bool {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if !origin {
		return true
	}
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	for _, r := range u.Host {
		if r > 127 {
			return false
		}
	}
	if port := u.Port(); port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 || n == 443 || strconv.Itoa(n) != port {
			return false
		}
	}
	return u.Path == "" && "https://"+strings.ToLower(u.Host) == value
}
func textLength(value string, min, max int) bool {
	n := len(utf16.Encode([]rune(value)))
	return n >= min && n <= max
}
func readPolicy(path string, v any) error {
	fail := func() error { return fault.New("worker_evidence_policy_invalid", 400) }
	if !filepath.IsAbs(path) {
		return fail()
	}
	f, e := os.Open(path)
	if e != nil {
		return fail()
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return fail()
	}
	b, e := io.ReadAll(io.LimitReader(f, 16385))
	if e != nil || len(b) > 16384 || protocol.Decode(b, v) != nil || !requiredPolicyFields(b, reflect.TypeOf(v).Elem()) {
		return fail()
	}
	return nil
}

// Mirrors the existing worker's conjunction of retirement.canProcessEvidence
// and incident.canProcessEvidence. Empty paths explicitly mean no policy as in
// the original startup loaders. Malformed/unknown declared evidence fails shut.
func loadEvidenceGate(endpoint, retirementFile, incidentFile string, now func() time.Time, observed ...func(*retirementPolicy, *incidentPolicy)) (func(context.Context) (bool, error), error) {
	invalid := func() (func(context.Context) (bool, error), error) {
		return func(context.Context) (bool, error) { return false, fault.New("worker_evidence_policy_invalid", 503) }, fault.New("worker_evidence_policy_invalid", 400)
	}
	var retirement *retirementPolicy
	if retirementFile != "" {
		retirement = &retirementPolicy{}
		if readPolicy(retirementFile, retirement) != nil {
			return invalid()
		}
		r := retirement
		if r.Version != 1 || !policyRef.MatchString(r.ID) || r.Endpoint != endpoint || !publicURL(r.Endpoint, true) || !textLength(r.Operator, 1, 200) || !textLength(r.Reason, 1, 2000) || r.AnnouncedAt < 0 || r.AnnouncedAt > r.StopWritesAt || r.StopWritesAt >= r.TakeoutUntil || r.TakeoutUntil >= r.StatusUntil || !publicURL(r.ContactURL, false) || !publicURL(r.DeletionPolicyURL, false) {
			return invalid()
		}
	}
	var incident *incidentPolicy
	if incidentFile != "" {
		incident = &incidentPolicy{}
		if readPolicy(incidentFile, incident) != nil {
			return invalid()
		}
		i := incident
		if i.Version != 1 || !policyRef.MatchString(i.ID) || i.Revision < 1 || i.Endpoint != endpoint || !publicURL(i.Endpoint, true) || i.UpdatedAt < 0 || i.UpdatedAt > now().Unix() || !textLength(strings.TrimSpace(i.PublicMessage), 1, 1200) || (i.State != "contained" && i.State != "recovery" && i.State != "resolved") {
			return invalid()
		}
		if i.Recovery != nil && (i.Recovery.CheckedAt < 0 || !evidenceHash.MatchString(i.Recovery.EvidenceSHA256)) {
			return invalid()
		}
		if i.State == "resolved" && (i.Recovery == nil || i.Recovery.CheckedAt > i.UpdatedAt) {
			return invalid()
		}
	}
	for _, capture := range observed {
		if capture != nil {
			capture(retirement, incident)
		}
	}
	return func(ctx context.Context) (bool, error) {
		if e := ctx.Err(); e != nil {
			return false, e
		}
		return (retirement == nil || now().Unix() < retirement.StopWritesAt) && (incident == nil || incident.State == "resolved"), nil
	}, nil
}

// encoding/json zero values do not make a missing/null required field valid.
// This retains the original strict schemas, including nested recovery fields.
func requiredPolicyFields(raw []byte, typ reflect.Type) bool {
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil || values == nil {
		return false
	}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		tag := strings.Split(field.Tag.Get("json"), ",")
		value, present := values[tag[0]]
		optional := len(tag) > 1 && tag[1] == "omitempty"
		if !present {
			if optional {
				continue
			}
			return false
		}
		null := bytes.Equal(bytes.TrimSpace(value), []byte("null"))
		if null {
			if field.Type.Kind() == reflect.Pointer {
				continue
			}
			return false
		}
		if field.Type.Kind() == reflect.Pointer && field.Type.Elem().Kind() == reflect.Struct && !requiredPolicyFields(value, field.Type.Elem()) {
			return false
		}
	}
	return true
}
