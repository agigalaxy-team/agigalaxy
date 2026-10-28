package messaging

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/textproto"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestOriginalFiveIdentityLetterheadAndMIMERoundTrip(t *testing.T) {
	messages := []MailMessage{}
	for key := range OfficialMailIdentities {
		for _, language := range []string{"zh-CN", "en-US"} {
			messages = append(messages, MailMessage{To: "synthetic@example.invalid", SenderKey: key, Subject: "Subject\r\nHeader", Title: `标题 <&"'>`, Paragraphs: []string{"first<&>", "", "second\nline"}, Note: "note'&", Language: language, MessageID: "<synthetic@messages.agigalaxy.org>"})
		}
	}
	inputs := []map[string]any{}
	for _, m := range messages {
		inputs = append(inputs, map[string]any{"subject": m.Subject, "title": m.Title, "paragraphs": m.Paragraphs, "note": m.Note, "language": m.Language, "automated": OfficialMailIdentities[m.SenderKey].Automated})
	}
	raw, _ := json.Marshal(inputs)
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", "--input-type=module", "-e", `import {renderGalaxyEmail} from './packages/galaxy-mail/src/layout.mjs';console.log(JSON.stringify(JSON.parse(process.argv[1]).map(renderGalaxyEmail)));`, string(raw))
	cmd.Dir = root
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatal(e, string(out))
	}
	var expected []struct{ Subject, HTML, Text string }
	if e = json.Unmarshal(out, &expected); e != nil {
		t.Fatal(e)
	}
	for i, message := range messages {
		actual, e := RenderMail(message, time.Now().UTC().Year())
		if e != nil {
			t.Fatal(e)
		}
		if !reflect.DeepEqual(actual, RenderedMail(expected[i])) {
			t.Fatalf("original render %s/%s differs", message.SenderKey, message.Language)
		}
		mimeBody, e := ComposeMail(message, time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC))
		if e != nil {
			t.Fatal(e)
		}
		parsed, e := mail.ReadMessage(bytes.NewReader(mimeBody))
		if e != nil {
			t.Fatal(e)
		}
		subject, e := new(mime.WordDecoder).DecodeHeader(parsed.Header.Get("Subject"))
		if e != nil || subject != "Subject  Header" {
			t.Fatal("subject header injection", subject, e)
		}
		from, e := mail.ParseAddress(parsed.Header.Get("From"))
		if e != nil || from.Address != OfficialMailIdentities[message.SenderKey].Address {
			t.Fatal("sender identity changed")
		}
		_, params, e := mime.ParseMediaType(parsed.Header.Get("Content-Type"))
		if e != nil {
			t.Fatal(e)
		}
		parts := multipart.NewReader(parsed.Body, params["boundary"])
		for _, kind := range []string{"text/plain", "text/html"} {
			part, e := parts.NextRawPart()
			if e != nil {
				t.Fatal(e)
			}
			if !strings.HasPrefix(part.Header.Get("Content-Type"), kind) {
				t.Fatal("MIME alternative order")
			}
			content, e := io.ReadAll(quotedprintable.NewReader(part))
			if e != nil {
				t.Fatal(e)
			}
			rendered, _ := RenderMail(message, 2030)
			want := rendered.Text
			if kind == "text/html" {
				want = rendered.HTML
			}
			if strings.ReplaceAll(string(content), "\r\n", "\n") != want {
				t.Fatal("MIME altered original body")
			}
		}
	}
}
func smtpFixture(t *testing.T, lostACK bool, block *atomic.Bool) (TransportConfiguration, <-chan []string) {
	t.Helper()
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { listener.Close() })
	done := make(chan []string, 1)
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			done <- nil
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		reader := bufio.NewReader(conn)
		writer := bufio.NewWriter(conn)
		send := func(s string) { writer.WriteString(s + "\r\n"); writer.Flush() }
		send("220 isolated.invalid SMTP")
		commands := []string{}
		for {
			line, e := reader.ReadString('\n')
			if e != nil {
				break
			}
			command := strings.ToUpper(strings.Fields(line)[0])
			commands = append(commands, command)
			switch command {
			case "EHLO":
				send("250-isolated.invalid\r\n250 AUTH PLAIN LOGIN CRAM-MD5")
			case "AUTH":
				send("235 authenticated")
			case "MAIL":
				send("250 sender")
			case "RCPT":
				if block != nil {
					block.Store(true)
				}
				send("250 recipient")
			case "DATA":
				send("354 data")
				text := textproto.NewReader(reader).DotReader()
				_, e := io.ReadAll(text)
				if e != nil {
					break
				}
				if lostACK {
					done <- commands
					return
				}
				send("250 accepted")
			case "QUIT":
				send("221 closing")
				done <- commands
				return
			default:
				send("500 unsupported")
			}
		}
		done <- commands
	}()
	return TransportConfiguration{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, TLS: "starttls", ConnectionTimeout: time.Second, GreetingTimeout: time.Second, SocketTimeout: time.Second}, done
}
func TestActualSMTPPhaseGateSubmittedAndUnknownNeverPretendFailure(t *testing.T) {
	message := MailMessage{To: "synthetic@example.invalid", SenderKey: "notice", Subject: "synthetic", Title: "Synthetic only", Paragraphs: []string{"isolated test"}, MessageID: "<synthetic@messages.agigalaxy.org>"}
	credentials := Credentials{User: "synthetic", Password: "synthetic"}
	transport := SMTPTransport{AllowLoopbackPlaintext: true}
	for _, lost := range []bool{false, true} {
		config, done := smtpFixture(t, lost, nil)
		calls := 0
		result := transport.Submit(context.Background(), config, credentials, func(context.Context) error { calls++; return nil }, message)
		commands := <-done
		if calls != 1 || !containsCommand(commands, "DATA") {
			t.Fatal("gate/SMTP missing", commands)
		}
		if lost {
			if result.Submission != "unknown" || result.Retryable || result.Code == nil || *result.Code != "smtp_submission_unknown" {
				t.Fatal("lost ACK misclassified", result)
			}
		} else if result.Submission != "submitted" {
			t.Fatal(result)
		}
	}
	var blocked atomic.Bool
	config, done := smtpFixture(t, false, &blocked)
	result := transport.Submit(context.Background(), config, credentials, func(context.Context) error {
		if !blocked.Load() {
			t.Error("authorized before RCPT acknowledgment")
		}
		return fault.New("operations_messaging_not_active", 403)
	}, message)
	commands := <-done
	if containsCommand(commands, "DATA") || result.Submission != "failed" || result.Code == nil || *result.Code != "operations_messaging_not_active" {
		t.Fatal("DATA authority bypass", result, commands)
	}
	config, done = smtpFixture(t, false, nil)
	result = (SMTPTransport{}).Submit(context.Background(), config, credentials, func(context.Context) error { return nil }, message)
	commands = <-done
	if result.Code == nil || *result.Code != "smtp_tls_failed" || containsCommand(commands, "AUTH") {
		t.Fatal("implicit plaintext fallback", result, commands)
	}
}
func containsCommand(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
