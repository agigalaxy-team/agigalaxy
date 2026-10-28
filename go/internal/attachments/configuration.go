package attachments

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Configuration struct {
	Store                                      Store
	Scanner                                    Scanner
	Policy                                     Policy
	DraftRetentionDays, SubmittedRetentionDays int
}

// LoadConfiguration uses the existing protected attachment file. Absence of an
// explicit file leaves storage unavailable; it never discovers or creates keys.
func LoadConfiguration(file, credentialDirectory string) (*Configuration, error) {
	explicit := file != ""
	if !explicit {
		if credentialDirectory == "" {
			return nil, nil
		}
		file = filepath.Join(credentialDirectory, "galaxy-attachments.json")
	}
	fail := func() (*Configuration, error) { return nil, fault.New("attachment_configuration_invalid", 400) }
	if !filepath.IsAbs(file) {
		return fail()
	}
	before, e := os.Lstat(file)
	if !explicit && errors.Is(e, os.ErrNotExist) {
		return nil, nil
	}
	if e != nil || !before.Mode().IsRegular() || before.Size() > 16384 {
		return fail()
	}
	if runtime.GOOS != "windows" {
		if explicit {
			if before.Mode().Perm()&0077 != 0 {
				return fail()
			}
		} else {
			d, e := os.Lstat(credentialDirectory)
			if e != nil || !d.IsDir() || d.Mode().Perm()&0227 != 0 || before.Mode().Perm()&0337 != 0 {
				return fail()
			}
			if !ownedByRuntime(d) || !ownedByRuntime(before) {
				return fail()
			}
		}
	}
	f, e := os.Open(file)
	if e != nil {
		return fail()
	}
	defer f.Close()
	opened, e := f.Stat()
	if e != nil || !os.SameFile(before, opened) {
		return fail()
	}
	b, e := io.ReadAll(io.LimitReader(f, 16385))
	if e != nil || len(b) > 16384 {
		return fail()
	}
	after, e := f.Stat()
	if e != nil || after.Size() != int64(len(b)) || !after.ModTime().Equal(opened.ModTime()) {
		return fail()
	}
	var x struct {
		Version int `json:"version"`
		Store   struct {
			Endpoint    string  `json:"endpoint"`
			Bucket      string  `json:"bucket"`
			Region      *string `json:"region,omitempty"`
			Credentials struct {
				AccessKeyID     string `json:"accessKeyId"`
				SecretAccessKey string `json:"secretAccessKey"`
			} `json:"credentials"`
			SSEKeyID     string `json:"sseKeyId"`
			SSEKeyBase64 string `json:"sseKeyBase64"`
		} `json:"store"`
		Scanner struct {
			Host                   *string `json:"host,omitempty"`
			Port                   int     `json:"port"`
			TimeoutMS              int     `json:"timeoutMs"`
			MaxSignatureAgeSeconds int     `json:"maxSignatureAgeSeconds"`
		} `json:"scanner"`
		Policy   Policy `json:"policy"`
		Feedback *struct {
			Draft     int `json:"draftRetentionDays"`
			Submitted int `json:"submittedRetentionDays"`
		} `json:"feedbackPolicy,omitempty"`
	}
	if protocol.Decode(b, &x) != nil || containsNull(b) || x.Version != 1 || !x.Policy.Valid() {
		return fail()
	}
	host := "127.0.0.1"
	if x.Scanner.Host != nil {
		host = *x.Scanner.Host
	}
	if host != "127.0.0.1" && host != "localhost" && host != "::1" || x.Scanner.Port < 1 || x.Scanner.Port > 65535 || x.Scanner.TimeoutMS < 1000 || x.Scanner.TimeoutMS > 60000 || x.Scanner.MaxSignatureAgeSeconds < 3600 || x.Scanner.MaxSignatureAgeSeconds > 259200 {
		return fail()
	}
	draft, submitted := 7, 30
	if x.Feedback != nil {
		draft, submitted = x.Feedback.Draft, x.Feedback.Submitted
	}
	if draft < 1 || draft > 30 || submitted < draft || submitted > 365 {
		return fail()
	}
	key, e := base64.StdEncoding.Strict().DecodeString(x.Store.SSEKeyBase64)
	if e != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != x.Store.SSEKeyBase64 {
		return fail()
	}
	region := "garage"
	if x.Store.Region != nil {
		region = *x.Store.Region
	}
	store, e := NewS3(S3Config{Endpoint: x.Store.Endpoint, Bucket: x.Store.Bucket, Region: region, AccessKeyID: x.Store.Credentials.AccessKeyID, SecretAccessKey: x.Store.Credentials.SecretAccessKey, SSEKeyID: x.Store.SSEKeyID, SSEKey: key, MaxBytes: x.Policy.MaxFileBytes})
	if e != nil {
		return fail()
	}
	return &Configuration{Store: store, Scanner: &ClamAV{Host: host, Port: x.Scanner.Port, Timeout: time.Duration(x.Scanner.TimeoutMS) * time.Millisecond, MaxBytes: x.Policy.MaxFileBytes, MaxSignatureAge: time.Duration(x.Scanner.MaxSignatureAgeSeconds) * time.Second}, Policy: x.Policy, DraftRetentionDays: draft, SubmittedRetentionDays: submitted}, nil
}

func containsNull(b []byte) bool {
	var value any
	if json.Unmarshal(b, &value) != nil {
		return true
	}
	var visit func(any) bool
	visit = func(v any) bool {
		if v == nil {
			return true
		}
		switch x := v.(type) {
		case map[string]any:
			for _, item := range x {
				if visit(item) {
					return true
				}
			}
		case []any:
			for _, item := range x {
				if visit(item) {
					return true
				}
			}
		}
		return false
	}
	return visit(value)
}
