// Package attachments adapts private object storage, bounded upload payloads and
// antivirus scanning. Content domains retain their own ledgers and permissions.
package attachments

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/gabriel-vasile/mimetype"
)

type Store interface {
	KeyID() string
	Put(context.Context, string, []byte, string) error
	Get(context.Context, string, string, int64) ([]byte, error)
}
type Scanner interface {
	Scan(context.Context, []byte) (map[string]any, error)
}
type Policy struct {
	Version            int   `json:"version"`
	MaxFileBytes       int64 `json:"maxFileBytes"`
	MaxSubjectBytes    int64 `json:"maxSubjectBytes"`
	MaxGlobalBytes     int64 `json:"maxGlobalBytes"`
	MaxFilesPerMessage int   `json:"maxFilesPerMessage"`
}

func DefaultPolicy() Policy { return Policy{1, 10485760, 67108864, 10737418240, 4} }
func (p Policy) Valid() bool {
	return p.Version == 1 && p.MaxFileBytes >= 1 && p.MaxFileBytes <= 67108864 && p.MaxSubjectBytes >= p.MaxFileBytes && p.MaxGlobalBytes >= p.MaxSubjectBytes && p.MaxFilesPerMessage >= 1 && p.MaxFilesPerMessage <= 16
}
func Digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func Integrity(b []byte, size int64, hash string) error {
	if b == nil || int64(len(b)) != size || Digest(b) != hash {
		return fault.New("attachment_storage_integrity_failed", 502)
	}
	return nil
}

// Detector is explicit because the Node file-type and Go magic databases differ.
// An unrecognized format never gets silently relabelled as the requested type.
type Detector func([]byte) (string, error)

func Detect(b []byte) (string, error) {
	if bytes.HasPrefix(b, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		return detectPNG(b), nil
	}
	m := mimetype.Detect(b)
	// file-type does not identify arbitrary plain text/JSON. Preserve its strict
	// UTF-8, NUL and JSON fallback instead of accepting mimetype's text heuristic.
	if m.Is("application/octet-stream") || m.Is("text/plain") || m.Is("application/json") {
		return "", nil
	}
	for _, format := range detectedFormats {
		if m.Is(format) {
			return format, nil
		}
	}
	return "", nil
}

// Preserve the current file-type PNG/APNG probe, including its bounded chunk
// traversal and incomplete-header outcome. A magic signature alone differs.
func detectPNG(b []byte) string {
	position := 8
	seenHeader := false
	for count := 0; count < 512; count++ {
		if position+8 > len(b) {
			return ""
		}
		length := int64(int32(binary.BigEndian.Uint32(b[position : position+4])))
		kind := string(b[position+4 : position+8])
		position += 8
		if length < 0 {
			return ""
		}
		if kind == "IHDR" {
			if length != 13 {
				return ""
			}
			seenHeader = true
		}
		switch kind {
		case "IDAT":
			return "image/png"
		case "acTL":
			return "image/apng"
		default:
			if !seenHeader && kind != "CgBI" {
				return ""
			}
			if length+4 > int64(len(b)-position) {
				return "image/png"
			}
			position += int(length) + 4
		}
		if position+8 >= len(b) {
			return "image/png"
		}
	}
	return "image/png"
}

type Payload struct {
	Size              int64
	SHA256, MediaType string
	MaxFileBytes      int64
	OnBytes           func(int)
	Detect            Detector
}

func ReadPayload(ctx context.Context, stream io.ReadCloser, p Payload) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = stream.Close() })
	defer stop()
	var b []byte
	buf := make([]byte, 65536)
	for {
		n, e := stream.Read(buf)
		if n > 0 {
			if p.OnBytes != nil {
				p.OnBytes(n)
			}
			if int64(len(b))+int64(n) > p.Size || int64(len(b))+int64(n) > p.MaxFileBytes {
				return nil, fault.New("attachment_too_large", 413)
			}
			b = append(b, buf[:n]...)
		}
		if ctx.Err() != nil {
			return nil, fault.New("attachment_upload_timeout", 408)
		}
		if e == io.EOF {
			break
		}
		if e != nil {
			var timeout net.Error
			if errors.As(e, &timeout) && timeout.Timeout() {
				return nil, fault.New("attachment_upload_timeout", 408)
			}
			return nil, e
		}
	}
	if int64(len(b)) != p.Size {
		return nil, fault.New("attachment_size_mismatch", 400)
	}
	if Digest(b) != p.SHA256 {
		return nil, fault.New("attachment_digest_mismatch", 400)
	}
	detect := p.Detect
	if detect == nil {
		detect = Detect
	}
	media, e := detect(b)
	if e != nil {
		return nil, fault.New("attachment_file_format_invalid", 400)
	}
	if p.MediaType != "application/octet-stream" {
		if media != "" {
			if media != p.MediaType {
				return nil, fault.New("attachment_media_type_mismatch", 400)
			}
		} else if p.MediaType == "text/plain" || p.MediaType == "application/json" {
			if !utf8.Valid(b) || strings.IndexByte(string(b), 0) >= 0 || p.MediaType == "application/json" && !json.Valid(b) {
				return nil, fault.New("attachment_media_type_mismatch", 400)
			}
		} else {
			return nil, fault.New("attachment_media_type_unrecognized", 400)
		}
	}
	return b, nil
}
