package messaging

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"net/textproto"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func tlsSMTPFixture(t *testing.T, implicit bool, authMethod string) (TransportConfiguration, *x509.CertPool, <-chan []string, *atomic.Uint32) {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "isolated SMTP"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, IsCA: true}
	der, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	certificate, e := x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	secure := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12}
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { listener.Close() })
	done := make(chan []string, 1)
	version := new(atomic.Uint32)
	go func() {
		raw, e := listener.Accept()
		if e != nil {
			done <- nil
			return
		}
		defer raw.Close()
		raw.SetDeadline(time.Now().Add(3 * time.Second))
		var conn net.Conn = raw
		upgraded := false
		if implicit {
			wrapped := tls.Server(raw, secure)
			if wrapped.Handshake() != nil {
				done <- nil
				return
			}
			version.Store(uint32(wrapped.ConnectionState().Version))
			conn = wrapped
			upgraded = true
		}
		reader, writer := bufio.NewReader(conn), bufio.NewWriter(conn)
		send := func(value string) { writer.WriteString(value + "\r\n"); writer.Flush() }
		send("220 isolated.invalid SMTP")
		commands := []string{}
		defer func() { done <- commands }()
		for {
			line, e := reader.ReadString('\n')
			if e != nil {
				return
			}
			fields := strings.Fields(line)
			if len(fields) == 0 {
				return
			}
			command := strings.ToUpper(fields[0])
			commands = append(commands, command)
			switch command {
			case "EHLO":
				if !upgraded {
					send("250-isolated.invalid\r\n250-STARTTLS\r\n250 AUTH " + authMethod)
				} else {
					send("250-isolated.invalid\r\n250 AUTH " + authMethod)
				}
			case "STARTTLS":
				send("220 begin TLS")
				wrapped := tls.Server(conn, secure)
				if wrapped.Handshake() != nil {
					return
				}
				version.Store(uint32(wrapped.ConnectionState().Version))
				conn = wrapped
				reader, writer = bufio.NewReader(conn), bufio.NewWriter(conn)
				upgraded = true
			case "AUTH":
				if authMethod == "LOGIN" {
					send("334 VXNlcm5hbWU6")
					if _, e = reader.ReadString('\n'); e != nil {
						return
					}
					send("334 UGFzc3dvcmQ6")
					if _, e = reader.ReadString('\n'); e != nil {
						return
					}
				} else if authMethod == "CRAM-MD5" {
					send("334 PHN5bnRoZXRpY0Bpc29sYXRlZD4=")
					if _, e = reader.ReadString('\n'); e != nil {
						return
					}
				}
				send("235 authenticated")
			case "MAIL", "RCPT":
				send("250 accepted")
			case "DATA":
				send("354 content")
				if _, e = io.Copy(io.Discard, textproto.NewReader(reader).DotReader()); e != nil {
					return
				}
				send("250 accepted")
			case "QUIT":
				send("221 bye")
				return
			default:
				send("500 unsupported")
			}
		}
	}()
	mode := "starttls"
	if implicit {
		mode = "implicit"
	}
	return TransportConfiguration{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, TLS: mode, ConnectionTimeout: time.Second, GreetingTimeout: time.Second, SocketTimeout: time.Second}, roots, done, version
}
func TestActualVerifiedImplicitTLSSTARTTLSAndAuthenticationFallbacks(t *testing.T) {
	for _, variant := range []struct {
		implicit bool
		auth     string
	}{{true, "PLAIN"}, {false, "PLAIN"}, {false, "LOGIN"}, {true, "CRAM-MD5"}} {
		t.Run(variant.auth+map[bool]string{true: "/implicit", false: "/starttls"}[variant.implicit], func(t *testing.T) {
			config, roots, done, version := tlsSMTPFixture(t, variant.implicit, variant.auth)
			transport := SMTPTransport{TLSConfig: &tls.Config{RootCAs: roots}}
			result := transport.Submit(context.Background(), config, Credentials{User: "synthetic", Password: "synthetic"}, func(context.Context) error { return nil }, MailMessage{To: "synthetic@example.invalid", SenderKey: "team", Subject: "Synthetic", Title: "Synthetic TLS", Paragraphs: []string{"isolated loopback only"}, MessageID: "<tls-test@messages.agigalaxy.org>"})
			commands := <-done
			if result.Submission != "submitted" || version.Load() < tls.VersionTLS12 {
				t.Fatal("TLS path failed", result, commands, version.Load())
			}
			if containsCommand(commands, "STARTTLS") == variant.implicit {
				t.Fatal("TLS mode changed", commands)
			}
		})
	}
	config, _, done, _ := tlsSMTPFixture(t, true, "PLAIN")
	result := (SMTPTransport{TLSConfig: &tls.Config{InsecureSkipVerify: true}}).Verify(context.Background(), config, Credentials{User: "synthetic", Password: "synthetic"}, func(context.Context) error { return nil })
	commands := <-done
	if result.Code == nil || *result.Code != "smtp_tls_failed" || containsCommand(commands, "AUTH") {
		t.Fatal("untrusted certificate accepted", result, commands)
	}
}
