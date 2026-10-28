package chat

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"github.com/google/uuid"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
)

const componentNS = "jabber:component:accept"
const roomsNS = "urn:galaxy:rooms:2"

// ComponentTransport speaks the original private XEP-0114 protocol. Archive
// bodies stay at Prosody; a lost IQ reply is an unknown delivery, never success.
type ComponentTransport struct {
	service, domain, roomsDomain, secret string
	timeout                              time.Duration
	mu                                   sync.Mutex
	conn                                 net.Conn
	pending                              map[string]chan transportReply
	probes                               map[string]bool
	online                               bool
	writeMu                              sync.Mutex
	started, reconnecting                bool
	generation                           uint64
	stopCh                               chan struct{}
}
type transportReply struct {
	value Object
	err   error
}

func NewComponentTransport(service, domain, roomsDomain, secret string, timeout time.Duration) (*ComponentTransport, error) {
	u, e := url.Parse(service)
	if e != nil || u.Scheme != "xmpp" || !has([]string{"127.0.0.1", "::1", "localhost"}, u.Hostname()) || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" || domain == "" || roomsDomain == "" || domain == roomsDomain || len(secret) < 32 {
		return nil, fmt.Errorf("invalid private chat component configuration")
	}
	if timeout <= 0 {
		timeout = 4 * time.Second
	}
	return &ComponentTransport{service: service, domain: domain, roomsDomain: roomsDomain, secret: secret, timeout: timeout, pending: map[string]chan transportReply{}, probes: map[string]bool{}}, nil
}
func (t *ComponentTransport) Available() bool { t.mu.Lock(); defer t.mu.Unlock(); return t.online }
func escaped(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
func attr(start xml.StartElement, key string) string {
	for _, a := range start.Attr {
		if a.Name.Local == key {
			return a.Value
		}
	}
	return ""
}
func (t *ComponentTransport) write(c net.Conn, s string) error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	if c == nil {
		return fail("chat_transport_unavailable", 503)
	}
	_ = c.SetWriteDeadline(time.Now().Add(t.timeout))
	_, e := io.WriteString(c, s)
	return e
}
func (t *ComponentTransport) Start(ctx context.Context) error {
	t.mu.Lock()
	if t.started {
		t.mu.Unlock()
		return fmt.Errorf("chat component already started")
	}
	t.started = true
	t.generation++
	generation := t.generation
	t.stopCh = make(chan struct{})
	t.mu.Unlock()
	err := t.connect(ctx, generation)
	if err != nil {
		t.scheduleReconnect(generation)
	}
	return err
}
func (t *ComponentTransport) connect(ctx context.Context, generation uint64) error {
	u, _ := url.Parse(t.service)
	port := u.Port()
	if port == "" {
		port = "5347"
	}
	c, e := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(u.Hostname(), port))
	if e != nil {
		return e
	}
	t.mu.Lock()
	if t.conn != nil || !t.started || t.generation != generation {
		t.mu.Unlock()
		c.Close()
		return fmt.Errorf("chat component unavailable")
	}
	t.conn = c
	t.mu.Unlock()
	_ = c.SetReadDeadline(time.Now().Add(t.timeout))
	if e = t.write(c, `<stream:stream xmlns='jabber:component:accept' xmlns:stream='http://etherx.jabber.org/streams' to='`+escaped(t.domain)+`'>`); e != nil {
		t.disconnect(c, generation)
		return e
	}
	decoder := xml.NewDecoder(c)
	streamID := ""
	for {
		token, e := decoder.Token()
		if e != nil {
			t.disconnect(c, generation)
			return e
		}
		if start, ok := token.(xml.StartElement); ok {
			if start.Name.Local != "stream" || start.Name.Space != "http://etherx.jabber.org/streams" {
				t.disconnect(c, generation)
				return fail("chat_transport_invalid_reply", 502)
			}
			streamID = attr(start, "id")
			break
		}
	}
	if streamID == "" {
		t.disconnect(c, generation)
		return fail("chat_transport_invalid_reply", 502)
	}
	sum := sha1.Sum([]byte(streamID + t.secret))
	if e = t.write(c, "<handshake>"+hex.EncodeToString(sum[:])+"</handshake>"); e != nil {
		t.disconnect(c, generation)
		return e
	}
	for {
		token, e := decoder.Token()
		if e != nil {
			t.disconnect(c, generation)
			return e
		}
		if start, ok := token.(xml.StartElement); ok {
			if start.Name.Local != "handshake" || start.Name.Space != componentNS {
				t.disconnect(c, generation)
				return fail("chat_transport_invalid_reply", 502)
			}
			if e = decoder.Skip(); e != nil {
				t.disconnect(c, generation)
				return e
			}
			break
		}
	}
	_ = c.SetReadDeadline(time.Time{})
	t.mu.Lock()
	if !t.started || t.generation != generation || t.conn != c {
		t.mu.Unlock()
		c.Close()
		return fmt.Errorf("chat component closed")
	}
	t.online = true
	t.mu.Unlock()
	go t.read(decoder, c, generation)
	return nil
}
func (t *ComponentTransport) Stop() error {
	t.mu.Lock()
	if t.started {
		close(t.stopCh)
	}
	t.started = false
	t.generation++
	t.reconnecting = false
	c := t.conn
	t.conn = nil
	t.online = false
	for id, ch := range t.pending {
		ch <- transportReply{err: fail("chat_delivery_unknown", 504)}
		delete(t.pending, id)
		delete(t.probes, id)
	}
	t.mu.Unlock()
	if c != nil {
		return c.Close()
	}
	return nil
}
func (t *ComponentTransport) disconnect(c net.Conn, generation uint64) {
	t.mu.Lock()
	same := t.conn == c && t.generation == generation
	if same {
		t.conn = nil
		t.online = false
		for id, ch := range t.pending {
			ch <- transportReply{err: fail("chat_delivery_unknown", 504)}
			delete(t.pending, id)
			delete(t.probes, id)
		}
	}
	t.mu.Unlock()
	c.Close()
	if same {
		t.scheduleReconnect(generation)
	}
}
func (t *ComponentTransport) scheduleReconnect(generation uint64) {
	t.mu.Lock()
	if !t.started || t.generation != generation || t.reconnecting {
		t.mu.Unlock()
		return
	}
	t.reconnecting = true
	stop := t.stopCh
	t.mu.Unlock()
	go func() {
		for {
			timer := time.NewTimer(time.Second)
			select {
			case <-stop:
				timer.Stop()
				return
			case <-timer.C:
			}
			ctx, cancel := context.WithTimeout(context.Background(), t.timeout)
			err := t.connect(ctx, generation)
			cancel()
			t.mu.Lock()
			if !t.started || t.generation != generation {
				t.mu.Unlock()
				return
			}
			if err == nil && t.online {
				t.reconnecting = false
				t.mu.Unlock()
				return
			}
			t.mu.Unlock()
		}
	}()
}
func (t *ComponentTransport) read(decoder *xml.Decoder, c net.Conn, generation uint64) {
	defer t.disconnect(c, generation)
	for {
		token, e := decoder.Token()
		if e != nil {
			return
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if start.Name.Local != "iq" {
			if decoder.Skip() != nil {
				return
			}
			continue
		}
		var stanza transportNode
		if e = decoder.DecodeElement(&stanza, &start); e != nil {
			return
		}
		if attr(start, "from") != t.roomsDomain {
			continue
		}
		id := attr(start, "id")
		t.mu.Lock()
		ch := t.pending[id]
		probe := t.probes[id]
		if ch != nil {
			delete(t.pending, id)
			delete(t.probes, id)
		}
		t.mu.Unlock()
		if ch == nil {
			continue
		}
		reply := transportReply{}
		if probe {
			if attr(start, "type") != "result" || !t.Available() || attr(start, "to") != t.domain || !mucReply(stanza) {
				reply.err = fail("chat_transport_invalid_reply", 502)
			} else {
				reply.value = Object{"authenticatedGateway": true, "roomsDomain": t.roomsDomain, "roundTrip": true, "readOnly": true, "bodyReturned": false}
			}
			ch <- reply
			continue
		}
		var result *transportNode
		for i := range stanza.Children {
			if stanza.Children[i].XMLName.Local == "result" && stanza.Children[i].XMLName.Space == roomsNS {
				result = &stanza.Children[i]
				break
			}
		}
		if attr(start, "type") != "result" || result == nil || json.Unmarshal([]byte(result.Text), &reply.value) != nil || reply.value == nil {
			reply.err = fail("chat_transport_invalid_reply", 502)
		} else if code := str(reply.value, "error"); code != "" {
			reply.err = fail(code)
		}
		ch <- reply
	}
}
func (t *ComponentTransport) Command(ctx context.Context, action string, input Object) (Object, error) {
	x := Object{"action": action}
	for k, v := range input {
		x[k] = v
	}
	raw, e := json.Marshal(x)
	if e != nil {
		return nil, e
	}
	return t.request(ctx, false, string(raw))
}

type transportNode struct {
	XMLName  xml.Name
	Attrs    []xml.Attr      `xml:",any,attr"`
	Text     string          `xml:",chardata"`
	Children []transportNode `xml:",any"`
}

func (n transportNode) attribute(key string) string {
	for _, a := range n.Attrs {
		if a.Name.Local == key {
			return a.Value
		}
	}
	return ""
}

const discoInfo = "http://jabber.org/protocol/disco#info"

func mucReply(n transportNode) bool {
	if len(n.Children) != 1 || strings.TrimSpace(n.Text) != "" {
		return false
	}
	query := n.Children[0]
	if query.XMLName.Local != "query" || query.XMLName.Space != discoInfo || query.attribute("node") != "" || strings.TrimSpace(query.Text) != "" {
		return false
	}
	identity, feature := false, false
	for _, child := range query.Children {
		if child.XMLName.Space == discoInfo && child.XMLName.Local == "identity" {
			identity = identity || child.attribute("category") == "conference" && child.attribute("type") == "text"
		} else if child.XMLName.Space == discoInfo && child.XMLName.Local == "feature" {
			feature = feature || child.attribute("var") == "http://jabber.org/protocol/muc"
		} else if child.XMLName.Space != "jabber:x:data" || child.XMLName.Local != "x" {
			return false
		}
	}
	return identity && feature
}
func (t *ComponentTransport) Probe(ctx context.Context) (Object, error) {
	return t.request(ctx, true, "")
}
func (t *ComponentTransport) request(ctx context.Context, probe bool, payload string) (Object, error) {
	id := uuid.NewString()
	ch := make(chan transportReply, 1)
	t.mu.Lock()
	if !t.online {
		t.mu.Unlock()
		return nil, fail("chat_transport_unavailable", 503)
	}
	t.pending[id] = ch
	t.probes[id] = probe
	c := t.conn
	t.mu.Unlock()
	defer func() { t.mu.Lock(); delete(t.pending, id); delete(t.probes, id); t.mu.Unlock() }()
	kind, body := "set", `<command xmlns='`+roomsNS+`'>`+escaped(payload)+`</command>`
	if probe {
		kind, body = "get", `<query xmlns='`+discoInfo+`'/>`
	}
	if e := t.write(c, `<iq type='`+kind+`' id='`+id+`' from='`+escaped(t.domain)+`' to='`+escaped(t.roomsDomain)+`'>`+body+`</iq>`); e != nil {
		return nil, fail("chat_delivery_unknown", 504)
	}
	timer := time.NewTimer(t.timeout)
	defer timer.Stop()
	select {
	case reply := <-ch:
		return reply.value, reply.err
	case <-timer.C:
		return nil, fail("chat_delivery_unknown", 504)
	case <-ctx.Done():
		return nil, fail("chat_delivery_unknown", 504)
	}
}
