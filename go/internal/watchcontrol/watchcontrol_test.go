package watchcontrol

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func node(t *testing.T, dsn, mode, path string, input any) Object {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/watchcontrol/testdata/interop.mjs"), mode, path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	cmd.Stdin = bytes.NewReader(encode(input))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, e := cmd.Output()
	if e != nil {
		t.Fatalf("original watch %s %v %s", mode, e, stderr.String())
	}
	var o Object
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if json.Unmarshal(line, &o) == nil && o != nil {
			return o
		}
	}
	t.Fatal("fixture result")
	return nil
}
func same(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	_ = json.Unmarshal(encode(a), &x)
	_ = json.Unmarshal(encode(b), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("Go=%s\nJS=%s", encode(a), encode(b))
	}
}
func copyObject(o Object) Object {
	out := Object{}
	for k, v := range o {
		out[k] = v
	}
	return out
}
func TestOriginalWatchControlCurrentDevicesLostACKTransferAndRestrictedRetention(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	path := filepath.Join(t.TempDir(), "watch-control-fixture.json")
	node(t, dsn, "setup", path, nil)
	raw, _ := os.ReadFile(path)
	var f Object
	if e := json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	rolePool := func(role string) *pgxpool.Pool {
		config := owner.Config()
		config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE "+role); return e }
		pool, e := pgxpool.NewWithConfig(ctx, config)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(pool.Close)
		return pool
	}
	api := rolePool("galaxy_api")
	now := func() time.Time { return time.Unix(number(f, "clock"), 0) }
	devices := &deviceauth.Service{Pool: api, Endpoint: text(f, "endpoint"), Now: now}
	actors := []deviceauth.Actor{}
	actorRows, _ := f["actors"].([]any)
	for _, value := range actorRows {
		a, e := devices.Authenticate(ctx, text(obj(value), "token"), "binding")
		if e != nil {
			t.Fatal(e)
		}
		actors = append(actors, a)
	}
	links := &accountlinks.Service{Endpoint: text(f, "endpoint"), Devices: devices}
	rooms := &chat.Service{Pool: api, Endpoint: text(f, "endpoint"), Devices: devices, Links: links, Now: now}
	tasks := &taskmaterials.Service{Pool: api, Endpoint: text(f, "endpoint"), Devices: devices, Links: links, Now: now}
	svc := &Service{Pool: api, Devices: devices, Room: rooms.WatchRoomWithin, Agent: rooms.WatchAgentWithin, Task: tasks.ReadTaskWithin, Now: now}
	read := func(q Object) (Object, error) {
		a := actors[number(q, "actor")]
		input := encode(q["input"])
		switch q["kind"] {
		case "get":
			return svc.Get(ctx, a, input)
		case "query":
			return svc.Query(ctx, a, input)
		case "receipt":
			return svc.Receipt(ctx, a, input)
		}
		t.Fatal("method")
		return nil, nil
	}
	compare := func(queries []any) {
		t.Helper()
		oracle := node(t, dsn, "read", path, queries)
		results, _ := oracle["results"].([]any)
		for i, value := range queries {
			want := obj(results[i])
			got, e := read(obj(value))
			if code := text(want, "error"); code != "" {
				if fault.Code(e) != code || int64(fault.Status(e)) != number(want, "status") {
					t.Fatalf("Go %v JS %v", e, want)
				}
				continue
			}
			if e != nil {
				t.Fatal(e)
			}
			same(t, got, want["value"])
		}
	}
	register := obj(f["register"])
	created, e := svc.Register(ctx, actors[0], encode(register))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = svc.Register(ctx, actors[0], encode(register)); e != nil {
		t.Fatal(e)
	}
	watchID := text(register, "watchId")
	receipt := Object{"operationId": register["operationId"], "requestHash": created["requestHash"]}
	compare([]any{Object{"kind": "get", "input": Object{"watchId": watchID}}, Object{"kind": "query", "input": Object{}}, Object{"kind": "receipt", "input": receipt}})
	var expiry time.Time
	if e = owner.QueryRow(ctx, `SELECT expires_at FROM chat_agent_grants WHERE grant_id=$1`, register["agentGrantId"]).Scan(&expiry); e != nil || expiry.Unix() != number(register, "expiresAt") {
		t.Fatal("grant deadline not bounded", e)
	}
	// A conflicting new grant must not revoke the selected source grant.
	collision := Object{"operationId": uuid.NewString(), "watchId": watchID, "expectedRevision": 1, "expectedGrantId": register["agentGrantId"], "targetBindingId": actors[1].BindingID, "newGrantId": f["unrelated"]}
	if _, e = svc.Takeover(ctx, actors[1], encode(collision)); fault.Code(e) != "watch_target_grant_exists" {
		t.Fatal(e)
	}
	var revoked bool
	if e = owner.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM chat_agent_grants WHERE grant_id=$1`, register["agentGrantId"]).Scan(&revoked); e != nil || revoked {
		t.Fatal("failed transfer revoked original grant", e)
	}
	takeover := copyObject(collision)
	takeover["operationId"] = uuid.NewString()
	takeover["newGrantId"] = uuid.NewString()
	moved, e := svc.Takeover(ctx, actors[1], encode(takeover))
	if e != nil {
		t.Fatal(e)
	}
	if obj(moved["watch"])["lastCursor"] != f["cursor"] || obj(moved["watch"])["externalProcessStopped"] != "unconfirmed" {
		t.Fatal(moved)
	}
	lostACK := Object{"operationId": takeover["operationId"], "requestHash": moved["requestHash"]}
	if recovered, e := svc.Receipt(ctx, actors[1], encode(lostACK)); e != nil {
		t.Fatal(e)
	} else {
		same(t, recovered, moved)
	}
	if replay, e := svc.Takeover(ctx, actors[1], encode(takeover)); e != nil {
		t.Fatal(e)
	} else {
		same(t, replay, moved)
	}
	compare([]any{Object{"actor": 1, "kind": "receipt", "input": lostACK}, Object{"actor": 1, "kind": "get", "input": Object{"watchId": watchID}}})
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
		return rooms.WatchAgentWithin(ctx, tx, &actors[0], text(f, "roomId"), text(register, "agentGrantId"))
	})
	if fault.Code(e) != "chat_agent_not_authorized" {
		t.Fatal(e)
	}
	blocked := obj(f["blocked"])
	if _, e = svc.Register(ctx, actors[0], encode(blocked)); e != nil {
		t.Fatal(e)
	}
	node(t, dsn, "revoke", path, Object{"grantId": blocked["agentGrantId"]})
	denied := copyObject(takeover)
	denied["operationId"] = uuid.NewString()
	denied["watchId"] = blocked["watchId"]
	denied["expectedGrantId"] = blocked["agentGrantId"]
	denied["newGrantId"] = uuid.NewString()
	if _, e = svc.Takeover(ctx, actors[1], encode(denied)); fault.Code(e) != "watch_source_grant_revoked" {
		t.Fatal(e)
	}
	contested := obj(f["contested"])
	if _, e = svc.Register(ctx, actors[0], encode(contested)); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, index := range []int{1, 2} {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			_, e := svc.Takeover(ctx, actors[index], encode(Object{"operationId": uuid.NewString(), "watchId": contested["watchId"], "expectedRevision": 1, "expectedGrantId": contested["agentGrantId"], "targetBindingId": actors[index].BindingID, "newGrantId": uuid.NewString()}))
			results <- e
		}(index)
	}
	wg.Wait()
	close(results)
	won := 0
	for e := range results {
		if e == nil {
			won++
		} else if fault.Code(e) != "watch_control_revision_conflict" {
			t.Fatal(e)
		}
	}
	if won != 1 {
		t.Fatalf("transfer winners %d", won)
	}
	// Simulate an already-committed membership departure, not a room-leave test.
	if _, e = owner.Exec(ctx, `UPDATE chat_memberships SET left_at=$3 WHERE room_id=$1 AND subject_id=$2`, f["roomId"], actors[0].SubjectID, now()); e != nil {
		t.Fatal(e)
	}
	compare([]any{Object{"actor": 1, "kind": "get", "input": Object{"watchId": watchID}}})
	stop := Object{"operationId": uuid.NewString(), "watchId": watchID, "expectedRevision": 2, "expectedGrantId": takeover["newGrantId"]}
	stopped, e := svc.Stop(ctx, actors[1], encode(stop))
	if e != nil {
		t.Fatal(e)
	}
	if obj(stopped["watch"])["state"] != "stopped" {
		t.Fatal(stopped)
	}
	if _, e = svc.Stop(ctx, actors[1], encode(stop)); e != nil {
		t.Fatal(e)
	}
	compare([]any{Object{"actor": 1, "kind": "receipt", "input": lostACK}})
	oldReceipt, e := svc.Receipt(ctx, actors[1], encode(lostACK))
	if e != nil || obj(oldReceipt["watch"])["state"] != "stopped" {
		t.Fatal("old receipt resurrected stopped control", e)
	}
	h := Handler{Service: svc, Devices: devices}
	var pages int
	h.ConsumeSearchPage = func(_ *http.Request, _ *deviceauth.Actor, after any) error { pages++; return nil }
	request := func(input Object) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v2/watch-controls/query", bytes.NewReader(encode(input)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+text(obj(actorRows[1]), "token"))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if r := request(Object{}); r.Code != 200 || pages != 0 {
		t.Fatal(r.Code, pages)
	}
	if r := request(Object{"after": nil}); r.Code != 200 || pages != 1 {
		t.Fatal(r.Code, pages)
	}
	if _, e = api.Exec(ctx, `UPDATE watch_control_operations_v2 SET result='{}' WHERE operation_id=$1`, register["operationId"]); e == nil {
		t.Fatal("API mutated immutable control receipt")
	}
	var active bool
	if e = owner.QueryRow(ctx, `SELECT revoked_at IS NULL FROM chat_agent_grants WHERE grant_id=$1`, f["unrelated"]).Scan(&active); e != nil || !active {
		t.Fatal("unrelated grant revoked", e)
	}
	worker := rolePool("galaxy_evidence_worker")
	svc.Now = func() time.Time { return now().Add(90*24*time.Hour + time.Second) }
	cleaned, e := postgres.InTx(ctx, worker, func(tx pgx.Tx) (Object, error) { return svc.PurgeExpiredWithin(ctx, tx) })
	if e != nil || number(cleaned, "watchControlReceipts") != 1 {
		t.Fatal(cleaned, e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM watch_control_operations_v2 WHERE watch_id=$1`, watchID).Scan(&count); e != nil || count != 0 {
		t.Fatal("bounded retention left stopped receipts", count, e)
	}
}
