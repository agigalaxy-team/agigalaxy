// Package chatarchivefixture is a synthetic loopback XMPP component for tests.
// It does not start a real Prosody instance or access an existing deployment.
package chatarchivefixture

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"io"
	"net"
	"sync"
	"testing"
)

const Secret = "isolated-component-secret-1234567890"
const roomsNS = "urn:galaxy:rooms:2"

type Object = map[string]any

func str(o Object, k string) string { v, _ := o[k].(string); return v }
func num(o Object, k string) int64 {
	switch v := o[k].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	}
	return 0
}
func uniqueStrings(v any) []string {
	out := []string{}
	seen := map[string]bool{}
	if values, ok := v.([]any); ok {
		for _, item := range values {
			if s, ok := item.(string); ok && !seen[s] {
				out = append(out, s)
				seen[s] = true
			}
		}
	}
	return out
}
func attr(start xml.StartElement, key string) string {
	for _, a := range start.Attr {
		if a.Name.Local == key {
			return a.Value
		}
	}
	return ""
}
func escaped(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

type Fixture struct {
	Listener      net.Listener
	Mu            sync.Mutex
	Bodies        map[string]Object
	SendIDs       []string
	LoseNext      bool
	LoseNextEdit  bool
	EraseNegative bool
	ProbeBody     string
	ReadHook      func()
	Connections   []net.Conn
}

func New(t *testing.T) *Fixture {
	t.Helper()
	l, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	f := &Fixture{Listener: l, Bodies: map[string]Object{}}
	t.Cleanup(func() {
		l.Close()
		f.Mu.Lock()
		defer f.Mu.Unlock()
		for _, c := range f.Connections {
			c.Close()
		}
	})
	go func() {
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			f.Mu.Lock()
			f.Connections = append(f.Connections, c)
			f.Mu.Unlock()
			go f.serve(c)
		}
	}()
	return f
}
func (f *Fixture) serve(c net.Conn) {
	defer c.Close()
	d := xml.NewDecoder(c)
	for {
		token, e := d.Token()
		if e != nil {
			return
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if start.Name.Local == "stream" {
			io.WriteString(c, `<stream:stream xmlns='jabber:component:accept' xmlns:stream='http://etherx.jabber.org/streams' id='isolated-stream' from='gateway.example.invalid'>`)
			continue
		}
		if start.Name.Local == "handshake" {
			var sum string
			if d.DecodeElement(&sum, &start) != nil {
				return
			}
			digest := sha1.Sum([]byte("isolated-stream" + Secret))
			if sum != hex.EncodeToString(digest[:]) {
				return
			}
			io.WriteString(c, "<handshake/>")
			continue
		}
		if start.Name.Local != "iq" {
			if d.Skip() != nil {
				return
			}
			continue
		}
		var stanza struct {
			Command string    `xml:"urn:galaxy:rooms:2 command"`
			Query   *struct{} `xml:"http://jabber.org/protocol/disco#info query"`
		}
		if d.DecodeElement(&stanza, &start) != nil {
			return
		}
		if stanza.Query != nil {
			f.Mu.Lock()
			body := f.ProbeBody
			f.Mu.Unlock()
			if body == "" {
				body = `<query xmlns='http://jabber.org/protocol/disco#info'><identity category='conference' type='text'/><feature var='http://jabber.org/protocol/muc'/></query>`
			}
			io.WriteString(c, `<iq type='result' from='rooms.example.invalid' to='gateway.example.invalid' id='`+attr(start, "id")+`'>`+body+`</iq>`)
			continue
		}
		var x Object
		if json.Unmarshal([]byte(stanza.Command), &x) != nil {
			return
		}
		result := Object{}
		f.Mu.Lock()
		switch str(x, "action") {
		case "project":
			result["projected"] = true
		case "send":
			id := str(x, "messageId")
			f.SendIDs = append(f.SendIDs, id)
			if f.Bodies[id] == nil {
				f.Bodies[id] = Object{"archiveId": id, "text": x["text"], "revision": float64(1)}
			}
			result["archiveId"] = id
		case "read", "export-own":
			items := []any{}
			for _, id := range uniqueStrings(x["ids"]) {
				if body := f.Bodies[id]; body != nil {
					copy := Object{}
					for k, v := range body {
						copy[k] = v
					}
					items = append(items, copy)
				}
			}
			result["messages"] = items
		case "edit":
			body := f.Bodies[str(x, "messageId")]
			if body != nil {
				body["text"] = x["text"]
				body["revision"] = num(x, "expectedRevision") + 1
				result["revision"] = body["revision"]
			}
		case "erase":
			if !f.EraseNegative {
				delete(f.Bodies, str(x, "messageId"))
			}
			result["archiveDeleted"] = !f.EraseNegative
		default:
			result["error"] = "unknown_command"
		}
		lose := str(x, "action") == "send" && f.LoseNext
		if lose {
			f.LoseNext = false
		}
		if str(x, "action") == "edit" && f.LoseNextEdit {
			lose = true
			f.LoseNextEdit = false
		}
		hook := f.ReadHook
		if str(x, "action") == "read" {
			f.ReadHook = nil
		} else {
			hook = nil
		}
		f.Mu.Unlock()
		if hook != nil {
			hook()
		}
		if lose {
			continue
		}
		raw, _ := json.Marshal(result)
		if _, e := io.WriteString(c, `<iq type='result' from='rooms.example.invalid' to='gateway.example.invalid' id='`+attr(start, "id")+`'><result xmlns='`+roomsNS+`'>`+escaped(string(raw))+`</result></iq>`); e != nil {
			return
		}
	}
}
