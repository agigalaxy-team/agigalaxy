package attachments

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type ClamAV struct {
	Host            string
	Port            int
	Timeout         time.Duration
	MaxBytes        int64
	MaxSignatureAge time.Duration
	Now             func() time.Time
}

func (c *ClamAV) command(ctx context.Context, command string, b []byte) (string, error) {
	fail := func() (string, error) { return "", fault.New("attachment_scanner_unavailable", 503) }
	if c.Host != "localhost" && c.Host != "127.0.0.1" && c.Host != "::1" || c.Port < 1 || c.Port > 65535 {
		return fail()
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, e := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(c.Host, strconv.Itoa(c.Port)))
	if e != nil {
		return fail()
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if _, e = io.WriteString(conn, "z"+command+"\x00"); e != nil {
		return fail()
	}
	if b != nil {
		for start := 0; start < len(b); start += 65536 {
			end := start + 65536
			if end > len(b) {
				end = len(b)
			}
			var h [4]byte
			binary.BigEndian.PutUint32(h[:], uint32(end-start))
			if _, e = conn.Write(append(h[:], b[start:end]...)); e != nil {
				return fail()
			}
		}
		if _, e = conn.Write(make([]byte, 4)); e != nil {
			return fail()
		}
	}
	answer, e := bufio.NewReader(io.LimitReader(conn, 4097)).ReadString(0)
	if e != nil || len(answer) > 4096 {
		return fail()
	}
	return strings.TrimSuffix(answer, "\x00"), nil
}

var clamVersion = regexp.MustCompile(`^ClamAV ([0-9.]+)/([0-9]+)/(.+)$`)
var clamFound = regexp.MustCompile(`^stream: .{1,200} FOUND$`)

func (c *ClamAV) Scan(ctx context.Context, b []byte) (map[string]any, error) {
	if int64(len(b)) > c.MaxBytes {
		return nil, fault.New("attachment_too_large", 413)
	}
	version, e := c.command(ctx, "VERSION", nil)
	if e != nil {
		return nil, e
	}
	m := clamVersion.FindStringSubmatch(version)
	if m == nil {
		return nil, fault.New("attachment_scanner_version_unavailable", 503)
	}
	now := time.Now()
	if c.Now != nil {
		now = c.Now()
	}
	age := c.MaxSignatureAge
	if age <= 0 {
		age = 72 * time.Hour
	}
	var at time.Time
	for _, layout := range []string{"Mon Jan 2 15:04:05 2006 MST", "Mon Jan _2 15:04:05 2006 MST", time.RFC3339} {
		at, e = time.Parse(layout, m[3]+" UTC")
		if e == nil {
			break
		}
		at, e = time.Parse(layout, m[3])
		if e == nil {
			break
		}
	}
	if e != nil || at.After(now.Add(300*time.Second)) || at.Before(now.Add(-age)) {
		return nil, fault.New("attachment_scanner_signatures_stale", 503)
	}
	response, e := c.command(ctx, "INSTREAM", b)
	if e != nil {
		return nil, e
	}
	result := map[string]any{"engine": "ClamAV", "engineVersion": m[1], "databaseVersion": m[2], "databaseUpdatedAt": at.Unix(), "checkedAt": now.Unix(), "scope": "configured-signatures-and-scan-limits", "guaranteedSafe": false}
	if response == "stream: OK" {
		result["state"] = "clean"
		return result, nil
	}
	if clamFound.MatchString(response) {
		result["state"] = "blocked"
		result["reason"] = "scanner-detection"
		return result, nil
	}
	return nil, fault.New("attachment_scan_incomplete", 503)
}
