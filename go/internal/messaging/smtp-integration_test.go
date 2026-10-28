package messaging

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type smtpHarness struct {
	listener   net.Listener
	mu         sync.Mutex
	rcpt, data func()
	loseACK    bool
	dataCalls  int
	messages   [][]byte
	wg         sync.WaitGroup
}

func newSMTPHarness(t *testing.T) *smtpHarness {
	t.Helper()
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	s := &smtpHarness{listener: listener}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, e := listener.Accept()
			if e != nil {
				return
			}
			s.wg.Add(1)
			go func() { defer s.wg.Done(); s.serve(conn) }()
		}
	}()
	t.Cleanup(func() { listener.Close(); s.wg.Wait() })
	return s
}
func (s *smtpHarness) serve(conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	r := bufio.NewReader(conn)
	w := bufio.NewWriter(conn)
	send := func(value string) { w.WriteString(value + "\r\n"); w.Flush() }
	send("220 isolated.invalid SMTP")
	for {
		line, e := r.ReadString('\n')
		if e != nil {
			return
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			return
		}
		switch strings.ToUpper(fields[0]) {
		case "EHLO":
			send("250-isolated.invalid\r\n250 AUTH PLAIN")
		case "AUTH":
			send("235 authenticated")
		case "MAIL":
			send("250 sender")
		case "RCPT":
			s.mu.Lock()
			hook := s.rcpt
			s.mu.Unlock()
			if hook != nil {
				hook()
			}
			send("250 recipient")
		case "DATA":
			send("354 data")
			body, e := io.ReadAll(textproto.NewReader(r).DotReader())
			if e != nil {
				return
			}
			s.mu.Lock()
			s.dataCalls++
			s.messages = append(s.messages, body)
			hook, lose := s.data, s.loseACK
			s.mu.Unlock()
			if hook != nil {
				hook()
			}
			if lose {
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
}
func (s *smtpHarness) count() int { s.mu.Lock(); defer s.mu.Unlock(); return s.dataCalls }
func TestActualSMTPAndPostgresClaimsDeferralsUnknownAndPauseAfterDATA(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs("../../..")
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {migrate} from './packages/galaxy-official/src/infrastructure/database.mjs';import {randomUUID} from 'node:crypto';const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(u.hostname!=='127.0.0.1'||!u.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated DB required');const db=new pg.Pool({connectionString:u.href});try{await migrate(db);const endpoint='https://smtp.example.invalid',operatorId='smtp-fixture',accountId=randomUUID();await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operator.example.invalid','synthetic','Synthetic',now(),now())",[operatorId,endpoint]);await db.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,'https://accounts.example.invalid','synthetic','external-account',now(),now())",[accountId,endpoint]);await db.query("INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at) VALUES($1,'person','Synthetic',now())",[accountId]);console.log(JSON.stringify({endpoint,operatorId,accountId}))}finally{await db.end()}`
	cmd := exec.Command("node", "--no-warnings", "--input-type=module", "-e", script)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatal(e, string(out))
	}
	var metadata struct{ Endpoint, OperatorID, AccountID string }
	if e = json.Unmarshal(out, &metadata); e != nil {
		t.Fatal(e)
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = jobs.MigrateWithin(ctx, pool, tx); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	queue, e := jobs.New(pool, nil)
	if e != nil {
		t.Fatal(e)
	}
	server := newSMTPHarness(t)
	port := server.listener.Addr().(*net.TCPAddr).Port
	var ticks atomic.Int64
	ticks.Store(2000000000)
	now := func() time.Time { return time.Unix(ticks.Load(), 0) }
	authority := &domainAuthority{actor: Actor{ID: metadata.OperatorID, Role: "administrator", Endpoint: metadata.Endpoint, Permissions: []string{"notices.read", "notices.create", "notices.update", "notices.publish", "notices.withdraw", "smtp.read", "smtp.configure", "smtp.test.connection", "smtp.test.delivery", "accounts.read"}}}
	var email atomic.Value
	email.Store("synthetic@example.invalid")
	directory := func(_ context.Context, issuer, subject string) (DirectoryIdentity, error) {
		return DirectoryIdentity{Issuer: issuer, ExternalSubject: subject, State: "available", Enabled: true, EmailVerified: true, Email: email.Load().(string)}, nil
	}
	resolver, e := NewCredentialResolver([]CredentialBinding{{Ref: "synthetic-approved", Label: "Synthetic only", Host: "127.0.0.1", Port: port, TLS: "starttls", Purposes: []string{"notice"}, User: "synthetic", Password: "SYNTHETIC-PRIVATE-PASSWORD"}})
	if e != nil {
		t.Fatal(e)
	}
	smtpService := &SMTPService{Pool: pool, Endpoint: metadata.Endpoint, Authority: authority, Directory: directory, Credentials: resolver, Transport: SMTPTransport{AllowLoopbackPlaintext: true, Now: now}, Now: now}
	service := &Service{Pool: pool, Endpoint: metadata.Endpoint, Authority: authority, Approver: authority, Jobs: queue, Now: now, Directory: directory, Mail: smtpService}
	configuration := Object{"enabled": true, "host": "127.0.0.1", "port": port, "tls": "starttls", "credentialRef": "synthetic-approved", "connectionTimeoutMs": 1000, "greetingTimeoutMs": 1000, "socketTimeoutMs": 1000, "maxConnections": 1, "rateLimit": 100, "rateWindowSeconds": 60, "dkimSelector": nil}
	saveInput := Object{"operationId": uuid.NewString(), "expectedVersion": 0, "configuration": configuration}
	saved, e := smtpService.Save(ctx, authority.actor, saveInput)
	if e != nil {
		t.Fatal("save SMTP", e)
	}
	if num(saved["version"]) != 1 {
		t.Fatal(saved)
	}
	if duplicate, e := smtpService.Save(ctx, authority.actor, saveInput); e != nil || !boolValue(duplicate["replayed"]) {
		t.Fatal("SMTP save replay", e)
	}
	connectionInput := Object{"operationId": uuid.NewString(), "expectedVersion": 1}
	connection, e := smtpService.Test(ctx, authority.actor, "connection", connectionInput)
	if e != nil || str(obj(connection["test"])["state"]) != "connected" {
		t.Fatal("connection test", e, encode(connection))
	}
	if duplicate, e := smtpService.Test(ctx, authority.actor, "connection", connectionInput); e != nil || !boolValue(duplicate["replayed"]) {
		t.Fatal("test claim replay", e)
	}
	// The DATA gate must re-read the real current directory address.
	server.mu.Lock()
	server.rcpt = func() { email.Store("changed@example.invalid") }
	server.mu.Unlock()
	changed, e := smtpService.Test(ctx, authority.actor, "delivery", Object{"operationId": uuid.NewString(), "expectedVersion": 1, "accountId": metadata.AccountID, "senderKey": "notice"})
	if e != nil || str(obj(changed["test"])["code"]) != "operations_messaging_recipient_ineligible" || server.count() != 0 {
		t.Fatal("changed email passed DATA", e, encode(changed))
	}
	server.mu.Lock()
	server.rcpt = nil
	server.mu.Unlock()
	email.Store("synthetic@example.invalid")
	makeRun := func() (Object, Object) {
		t.Helper()
		created, e := service.Create(ctx, authority.actor, Object{"operationId": uuid.NewString(), "config": Object{"channels": []any{"email"}, "content": Object{"purpose": "service-update", "title": "Synthetic message", "body": "Synthetic body only", "href": nil, "expiresAt": iso(now().Add(time.Hour))}, "audience": Object{"kind": "accounts", "accountIds": []any{metadata.AccountID}}, "senderKey": "notice", "schedule": Object{"kind": "immediate"}}})
		if e != nil {
			t.Fatal(e)
		}
		plan := obj(created["plan"])
		active, e := service.Action(ctx, authority.actor, str(plan["id"]), "activate", Object{"operationId": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 1})
		if e != nil {
			t.Fatal(e)
		}
		plan = obj(active["plan"])
		executed, e := service.ExecutePlan(ctx, jobs.Task{ID: str(plan["jobId"]), Endpoint: metadata.Endpoint, Action: jobs.MessagingRun, SourceID: str(plan["id"]), OperationID: str(plan["jobId"]), PlanVersion: 1})
		if e != nil {
			t.Fatal(e)
		}
		return plan, obj(executed["run"])
	}
	_, run := makeRun()
	smtpService.mu.Lock()
	smtpService.active = 1
	smtpService.mu.Unlock()
	deferred, e := service.Deliver(ctx, str(run["id"]))
	if e != nil || str(obj(deferred["run"])["state"]) != "running" || server.count() != 0 {
		t.Fatal("local capacity", e, encode(deferred))
	}
	recipients, e := service.Recipients(ctx, authority.actor, str(run["id"]), Object{})
	if e != nil {
		t.Fatal(e)
	}
	recipient := obj(arr(recipients["items"])[0])
	stableID := str(recipient["messageId"])
	if num(recipient["attemptCount"]) != 0 || !boolValue(recipient["deferred"]) {
		t.Fatal("capacity spent network attempt", encode(recipient))
	}
	smtpService.mu.Lock()
	smtpService.active = 0
	smtpService.mu.Unlock()
	ticks.Add(31)
	sent, e := service.Deliver(ctx, str(run["id"]))
	if e != nil || num(obj(obj(obj(sent["run"])["delivery"])["email"])["submitted"]) != 1 || server.count() != 1 {
		t.Fatal("deferred continuation", e, encode(sent))
	}
	recipients, e = service.Recipients(ctx, authority.actor, str(run["id"]), Object{})
	recipient = obj(arr(recipients["items"])[0])
	if str(recipient["messageId"]) != stableID || num(recipient["attemptCount"]) != 1 || len(arr(recipient["attempts"])) != 2 {
		t.Fatal("attempt history/id changed", encode(recipient))
	}
	// Lost acceptance ACK is unknown, never selected by retry or a second worker.
	_, run = makeRun()
	server.mu.Lock()
	server.loseACK = true
	server.mu.Unlock()
	unknown, e := service.Deliver(ctx, str(run["id"]))
	if e != nil {
		t.Fatal(e)
	}
	if num(obj(obj(obj(unknown["run"])["delivery"])["email"])["unknown"]) != 1 {
		t.Fatal("lost ACK not unknown", encode(unknown))
	}
	before := server.count()
	if _, e = service.Deliver(ctx, str(run["id"])); e != nil {
		t.Fatal(e)
	}
	if server.count() != before {
		t.Fatal("unknown resent")
	}
	latest, e := service.Run(ctx, authority.actor, str(run["id"]))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = service.Retry(ctx, authority.actor, str(run["id"]), Object{"operationId": uuid.NewString(), "expectedRevision": obj(latest["run"])["revision"]}); fault.Code(e) != "operations_messaging_retry_not_allowed" {
		t.Fatal("unknown manually retried", e)
	}
	// A lease left after process termination is also conservative unknown.
	server.mu.Lock()
	server.loseACK = false
	server.mu.Unlock()
	_, run = makeRun()
	claim, e := service.claim(ctx, str(run["id"]))
	if e != nil || claim == nil || claim.processed {
		t.Fatal("claim", e)
	}
	ticks.Add(301)
	recovered, e := service.Deliver(ctx, str(run["id"]))
	if e != nil || num(obj(obj(obj(recovered["run"])["delivery"])["email"])["unknown"]) != 1 || server.count() != before {
		t.Fatal("lease recovery resent", e, encode(recovered))
	}
	// Pausing after DATA cannot retract an already accepted SMTP submission.
	plan, run := makeRun()
	server.mu.Lock()
	server.data = func() {
		_, err := service.Action(ctx, authority.actor, str(plan["id"]), "pause", Object{"operationId": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 2})
		if err != nil {
			t.Error(err)
		}
	}
	server.mu.Unlock()
	paused, e := service.Deliver(ctx, str(run["id"]))
	if e != nil || str(obj(paused["run"])["state"]) != "paused" || num(obj(obj(obj(paused["run"])["delivery"])["email"])["submitted"]) != 1 {
		t.Fatal("pause replaced actual receipt", e, encode(paused))
	}

	server.mu.Lock()
	server.data = nil
	server.rcpt = nil
	server.mu.Unlock()
	// The existing management screens read the same nonsecret Go-owned tables.
	directoryFile := filepath.Join(t.TempDir(), "synthetic-smtp.json")
	credentialDocument := Object{"version": 1, "endpoint": metadata.Endpoint, "credentials": []any{Object{"ref": "synthetic-approved", "label": "Synthetic only", "host": "127.0.0.1", "port": port, "tls": "starttls", "purposes": []any{"notice"}, "user": "synthetic", "password": "SYNTHETIC-PRIVATE-PASSWORD"}}}
	os.WriteFile(directoryFile, []byte(encode(credentialDocument)), 0600)
	outputs := map[string]Object{}
	outputs["get"], e = smtpService.Get(ctx, authority.actor)
	if e != nil {
		t.Fatal(e)
	}
	outputs["history"], e = smtpService.History(ctx, authority.actor, Object{})
	if e != nil {
		t.Fatal(e)
	}
	outputs["tests"], e = smtpService.Tests(ctx, authority.actor, Object{})
	if e != nil {
		t.Fatal(e)
	}
	outputs["queue"], e = smtpService.Queue(ctx, authority.actor, Object{})
	if e != nil {
		t.Fatal(e)
	}
	outputs["receipt"], e = smtpService.CommandResult(ctx, authority.actor, str(connectionInput["operationId"]))
	if e != nil {
		t.Fatal(e)
	}
	script = `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {OperationsPermissionsService} from './packages/galaxy-official/src/operations/permissions/index.mjs';import {BusinessAdminService} from './packages/galaxy-official/src/operations/audit/service.mjs';import {OperationsSmtpService} from './packages/galaxy-official/src/operations/messaging/smtp.mjs';import {loadOperationsSmtpCredentials} from './packages/galaxy-official/src/infrastructure/operations-smtp-credentials.mjs';const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(u.hostname!=='127.0.0.1'||!u.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated DB required');const db=new pg.Pool({connectionString:u.href});try{const endpoint='https://smtp.example.invalid',now=()=>Number(process.argv[3]),permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async()=>'administrator',now}),businessAdmin=new BusinessAdminService({db,endpoint,permissions,now}),actor={kind:'business-operator',operatorId:'smtp-fixture',role:'administrator',endpoint},credentialResolver=await loadOperationsSmtpCredentials(process.argv[1],{endpoint}),smtp=new OperationsSmtpService({db,endpoint,businessAdmin,credentialResolver,now});console.log(JSON.stringify({get:await smtp.get(actor),history:await smtp.history(actor),tests:await smtp.tests(actor),queue:await smtp.queue(actor),receipt:await smtp.commandResult(actor,process.argv[2])}))}finally{await db.end()}`
	cmd = exec.Command("node", "--no-warnings", "--input-type=module", "-e", script, directoryFile, str(connectionInput["operationId"]), decimal(ticks.Load()))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e = cmd.CombinedOutput()
	if e != nil {
		t.Fatal("SMTP original readback", e, string(out))
	}
	var old map[string]Object
	if e = json.Unmarshal(out, &old); e != nil {
		t.Fatal(e)
	}
	for name, value := range outputs {
		if !same(value, old[name]) {
			t.Fatalf("SMTP original %s mismatch\nGo %s\nJS %s", name, encode(value), encode(old[name]))
		}
	}
	dnsCalls := []string{}
	smtpService.ResolveTXT = func(_ context.Context, name string) ([]string, error) {
		dnsCalls = append(dnsCalls, name)
		if name == "agigalaxy.org" {
			return []string{"v=spf1 synthetic -all"}, nil
		}
		return []string{"v=DMARC1; p=none"}, nil
	}
	domains, e := smtpService.Domains(ctx, authority.actor)
	if e != nil || len(dnsCalls) != 2 || str(obj(domains["spf"])["state"]) != "record-found" || str(obj(domains["dkim"])["state"]) != "selector-not-configured" {
		t.Fatal("DNS truthful state", e, encode(domains))
	}
	httpServer := httptest.NewServer(Handler{Service: service, SMTP: smtpService, Authority: authority})
	defer httpServer.Close()
	response, e := httpServer.Client().Get(httpServer.URL + "/v1/operations/smtp/history?limit=0x1")
	if e != nil {
		t.Fatal(e)
	}
	var httpValue Object
	json.NewDecoder(response.Body).Decode(&httpValue)
	response.Body.Close()
	if response.StatusCode != 200 || len(arr(httpValue["items"])) != 1 {
		t.Fatal("SMTP HTTP read", response.StatusCode, encode(httpValue))
	}
	inputBody := encode(Object{"operationId": uuid.NewString(), "expectedVersion": 1, "accountId": metadata.AccountID, "senderKey": "team", "to": "arbitrary@example.invalid"})
	beforeHTTP := server.count()
	response, e = httpServer.Client().Post(httpServer.URL+"/v1/operations/smtp/tests/delivery", "application/json", strings.NewReader(inputBody))
	if e != nil {
		t.Fatal(e)
	}
	json.NewDecoder(response.Body).Decode(&httpValue)
	response.Body.Close()
	if response.StatusCode != 400 || str(httpValue["error"]) != "invalid_smtp_request" || server.count() != beforeHTTP {
		t.Fatal("HTTP arbitrary address bypass", response.StatusCode, encode(httpValue))
	}
	request, _ := http.NewRequest("POST", httpServer.URL+"/v1/operations/smtp/tests/connection", strings.NewReader(encode(connectionInput)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Content-Encoding", "gzip")
	response, e = httpServer.Client().Do(request)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 415 {
		t.Fatal("unsupported SMTP body encoding accepted")
	}
	view, e := smtpService.Get(ctx, authority.actor)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(encode(view), "SYNTHETIC-PRIVATE-PASSWORD") {
		t.Fatal("credential leaked")
	}
	receipt, e := smtpService.CommandResult(ctx, authority.actor, str(connectionInput["operationId"]))
	if e != nil || str(obj(receipt["result"])["state"]) != "connected" {
		t.Fatal("immutable test receipt", e, encode(receipt))
	}
}
