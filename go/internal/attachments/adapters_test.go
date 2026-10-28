package attachments

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestPrivateS3ProtocolSSECAndNoRetry(t *testing.T) {
	data := []byte("private attachment")
	var puts atomic.Int32
	var fail atomic.Bool
	var redirect atomic.Bool
	var followed atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { followed.Add(1); w.WriteHeader(200) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/private-attachments/feedback-attachments/11111111-1111-4111-8111-111111111111" {
			t.Errorf("path %s", r.URL.Path)
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Error("missing real SDK signature")
		}
		if r.Header.Get("X-Amz-Server-Side-Encryption-Customer-Algorithm") != "AES256" || r.Header.Get("X-Amz-Server-Side-Encryption-Customer-Key") != base64.StdEncoding.EncodeToString(make([]byte, 32)) || r.Header.Get("X-Amz-Server-Side-Encryption-Customer-Key-Md5") == "" {
			t.Error("missing or altered SSE-C headers")
		}
		if r.Method == "PUT" {
			puts.Add(1)
			if redirect.Load() {
				w.Header().Set("Location", target.URL)
				w.WriteHeader(307)
				return
			}
			if fail.Load() {
				w.WriteHeader(503)
				return
			}
			b, _ := io.ReadAll(r.Body)
			if !bytes.Equal(b, data) || r.Header.Get("X-Amz-Meta-Sha256") != Digest(data) {
				t.Error("payload metadata differs")
			}
			w.WriteHeader(200)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("X-Amz-Meta-Sha256", Digest(data))
		_, _ = w.Write(data)
	}))
	defer server.Close()
	store, e := NewS3(S3Config{Endpoint: server.URL, Bucket: "private-attachments", AccessKeyID: "fixture-access", SecretAccessKey: "fixture-secret", SSEKeyID: "fixture-key", SSEKey: make([]byte, 32)})
	if e != nil {
		t.Fatal(e)
	}
	key := "feedback-attachments/11111111-1111-4111-8111-111111111111"
	if e = store.Put(context.Background(), key, data, Digest(data)); e != nil {
		t.Fatal(e)
	}
	got, e := store.Get(context.Background(), key, "fixture-key", int64(len(data)))
	if e != nil || !bytes.Equal(got, data) {
		t.Fatalf("get %v", e)
	}
	head, e := store.Head(context.Background(), key, "fixture-key")
	if e != nil || head == nil || head.Size != int64(len(data)) || head.SHA256 == nil || *head.SHA256 != Digest(data) {
		t.Fatalf("HEAD metadata %v %v", head, e)
	}
	_, e = store.Get(context.Background(), key, "previous-key", int64(len(data)))
	if fault.Code(e) != "attachment_encryption_key_unavailable" {
		t.Fatal(e)
	}
	fail.Store(true)
	e = store.Put(context.Background(), key, data, Digest(data))
	if fault.Code(e) != "attachment_storage_unavailable" || puts.Load() != 2 {
		t.Fatalf("unknown put must not retry: %v attempts=%d", e, puts.Load())
	}
	fail.Store(false)
	redirect.Store(true)
	e = store.Put(context.Background(), key, data, Digest(data))
	if fault.Code(e) != "attachment_storage_unavailable" || followed.Load() != 0 {
		t.Fatalf("private SSE-C request followed redirect: %v requests=%d", e, followed.Load())
	}
}
func TestBoundedPayloadValidation(t *testing.T) {
	for _, tc := range []struct {
		name              string
		b                 []byte
		media, hash, code string
		size              int64
	}{
		{"json", []byte(`{"ok":true}`), "application/json", "", "", 11},
		{"bad-json", []byte(`{bad}`), "application/json", "", "attachment_media_type_mismatch", 5},
		{"invalid-utf8", []byte{255}, "text/plain", "", "attachment_media_type_mismatch", 1},
		{"nul", []byte{'a', 0}, "text/plain", "", "attachment_media_type_mismatch", 2},
		{"digest", []byte("hello"), "text/plain", strings.Repeat("0", 64), "attachment_digest_mismatch", 5},
		{"overrun", []byte("hello"), "text/plain", "", "attachment_too_large", 4},
		{"truncated", []byte("hi"), "text/plain", "", "attachment_size_mismatch", 3},
		{"opaque", []byte{0, 1, 2}, "application/octet-stream", "", "", 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hash := tc.hash
			if hash == "" {
				hash = Digest(tc.b)
			}
			_, e := ReadPayload(context.Background(), io.NopCloser(bytes.NewReader(tc.b)), Payload{tc.size, hash, tc.media, 1024, nil, nil})
			if tc.code == "" && e != nil || tc.code != "" && fault.Code(e) != tc.code {
				t.Fatalf("want %s: %v", tc.code, e)
			}
		})
	}
}

func TestPayloadDeadlineClosesBlockedRead(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, e := ReadPayload(ctx, reader, Payload{Size: 1, MaxFileBytes: 1, MediaType: "application/octet-stream"})
	if fault.Code(e) != "attachment_upload_timeout" {
		t.Fatalf("deadline %v", e)
	}
}

func TestPayloadAgainstCurrentNodeParser(t *testing.T) {
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8GQAAAAASUVORK5CYII=")
	cases := []struct {
		Bytes []byte `json:"bytes"`
		Media string `json:"media"`
	}{
		{png, "image/png"}, {png, "text/plain"}, {[]byte("<html><body>text</body></html>"), "text/plain"},
		{[]byte("<?xml version=\"1.0\"?><root/>"), "application/xml"}, {[]byte(`{"ok":true}`), "application/json"},
		{[]byte("%PDF-1.7\nfixture"), "application/pdf"}, {[]byte{137, 80, 78, 71, 13, 10, 26, 10}, "image/png"},
	}
	root, e := filepath.Abs(filepath.Join("..", "..", ".."))
	if e != nil {
		t.Fatal(e)
	}
	script := `import {readAttachmentPayload} from './packages/galaxy-official/src/infrastructure/attachment-payload.mjs';import {createHash} from 'node:crypto';let raw='';for await(const b of process.stdin)raw+=b;const out=[];for(const x of JSON.parse(raw)){const bytes=Buffer.from(x.bytes,'base64');try{await readAttachmentPayload((async function*(){yield bytes})(),{size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:x.media,maxFileBytes:10485760});out.push('')}catch(e){out.push(e.code??'internal_error')}}console.log(JSON.stringify(out));`
	raw, _ := json.Marshal(cases)
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(raw)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original payload parser %v %s", e, out)
	}
	var expected []string
	if e = json.Unmarshal(out, &expected); e != nil {
		t.Fatal(e)
	}
	for i, c := range cases {
		_, e := ReadPayload(context.Background(), io.NopCloser(bytes.NewReader(c.Bytes)), Payload{int64(len(c.Bytes)), Digest(c.Bytes), c.Media, 10485760, nil, nil})
		got := ""
		if e != nil {
			got = fault.Code(e)
		}
		if got != expected[i] {
			t.Errorf("case %d %s: original=%s Go=%s", i, c.Media, expected[i], got)
		}
	}
}

// A controlled TCP daemon verifies the real ClamAV wire adapter; this does not
// establish that any installed signature database detects actual malware.
func TestClamAVWireAndSignatureAge(t *testing.T) {
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	var stale atomic.Bool
	go func() {
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			go func() {
				defer conn.Close()
				var cmd []byte
				var one [1]byte
				for {
					if _, e := io.ReadFull(conn, one[:]); e != nil {
						return
					}
					if one[0] == 0 {
						break
					}
					cmd = append(cmd, one[0])
				}
				if string(cmd) == "zVERSION" {
					at := now
					if stale.Load() {
						at = at.Add(-96 * time.Hour)
					}
					_, _ = fmt.Fprintf(conn, "ClamAV 1.4.3/12345/%s\x00", at.Format("Mon Jan 2 15:04:05 2006"))
					return
				}
				if string(cmd) != "zINSTREAM" {
					return
				}
				var got []byte
				for {
					var h [4]byte
					if _, e := io.ReadFull(conn, h[:]); e != nil {
						return
					}
					n := binary.BigEndian.Uint32(h[:])
					if n == 0 {
						break
					}
					b := make([]byte, n)
					if _, e := io.ReadFull(conn, b); e != nil {
						return
					}
					got = append(got, b...)
				}
				if string(got) == "blocked" {
					_, _ = io.WriteString(conn, "stream: Test.Signature FOUND\x00")
				} else {
					_, _ = io.WriteString(conn, "stream: OK\x00")
				}
			}()
		}
	}()
	scanner := &ClamAV{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, MaxBytes: 10485760, Now: func() time.Time { return now }}
	result, e := scanner.Scan(context.Background(), []byte("blocked"))
	if e != nil || result["state"] != "blocked" || result["guaranteedSafe"] != false {
		t.Fatalf("scan %v %v", result, e)
	}
	stale.Store(true)
	_, e = scanner.Scan(context.Background(), []byte("clean"))
	if fault.Code(e) != "attachment_scanner_signatures_stale" {
		t.Fatal(e)
	}
}
