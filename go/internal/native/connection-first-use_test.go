package native

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestFirstConnectRegistersLocalIdentityAndReconcilesOriginal(t *testing.T) {
	_, meta, transport := connectionServiceFixture(t)
	for _, lostReceipt := range []bool{false, true} {
		name := "new-device"
		if lostReceipt {
			name = "lost-commit-receipt"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			config := meta.Configuration
			config.DataDirectory = t.TempDir()
			store, e := NewStore(config.DataDirectory, config.Endpoint)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = store.Initialize(ctx, InitializationInput{SubjectType: "person"}, true, nil); e != nil {
				t.Fatal(e)
			}
			local, e := store.Identity(ctx)
			if e != nil {
				t.Fatal(e)
			}
			newRuntime := func() *Runtime {
				r, e := NewRuntime(store, config, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return time.Unix(meta.Now, 0) }})
				if e != nil {
					t.Fatal(e)
				}
				t.Cleanup(r.Close)
				return r
			}
			r := newRuntime()
			before := transport.count()
			plan, e := r.PrepareConnect(ctx)
			if e != nil || !plan.FirstUse || plan.GalaxyID != local["id"] || plan.DeviceID != "" {
				t.Fatal("first-use plan", plan, e)
			}
			if transport.count() != before {
				t.Fatal("preparing connection made remote writes")
			}
			scope, e := store.ChoiceScope(ctx)
			if e != nil {
				t.Fatal(e)
			}
			commits := 0
			transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
				if request.URL.Path == "/v2/identity/control/commit" {
					commits++
					if lostReceipt && commits == 1 {
						response.Body.Close()
						return nil, errors.New("lost receipt after commit")
					}
				}
				return response, nil
			})
			defer transport.setHook(nil)
			var snapshot *ConnectionSnapshot
			if lostReceipt {
				snapshot, e = r.ConnectReviewed(ctx, plan, &scope)
			} else {
				snapshot = connectFirstIdentityInBrowser(t, ctx, r, transport)
			}
			if lostReceipt {
				if e == nil {
					t.Fatal("lost receipt claimed success")
				}
				r.Close()
				r = newRuntime()
				plan, e = r.PrepareConnect(ctx)
				if e != nil {
					t.Fatal(e)
				}
				snapshot, e = r.ConnectReviewed(ctx, plan, &scope)
			}
			if e != nil || snapshot == nil || snapshot.SubjectID != local["id"] || snapshot.BindingID == "" {
				t.Fatal("first real connection", snapshot, e)
			}
			if commits != 1 {
				t.Fatalf("bootstrap sent %d commits", commits)
			}
			plan, e = r.PrepareConnect(ctx)
			if e != nil || plan.FirstUse || plan.DeviceID == "" {
				t.Fatal("connection did not become a normal selected device", plan, e)
			}
			identityAfter, e := store.Identity(ctx)
			if e != nil || !connectionEqual(local, identityAfter) {
				t.Fatal("connection replaced local identity", e)
			}
		})
	}
}

func connectFirstIdentityInBrowser(t *testing.T, ctx context.Context, runtime *Runtime, transport *connectionTestTransport) *ConnectionSnapshot {
	t.Helper()
	server, err := NewRuntimeToolServer(runtime.store, runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	hostForms := 0
	client := mcp.NewClient(&mcp.Implementation{Name: "host-with-hidden-form", Version: "1"}, &mcp.ClientOptions{
		ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
			hostForms++
			return &mcp.ElicitResult{Action: "decline"}, nil
		},
	})
	session, err := client.Connect(ctx, clientTransport, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	call := func() map[string]any {
		t.Helper()
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_native_connect", Arguments: map[string]any{}})
		if err != nil || result == nil || result.IsError {
			t.Fatalf("connect tool: %+v, %v", result, err)
		}
		var payload map[string]any
		nativeTestDecodeResult(t, result, &payload)
		return payload
	}
	before := transport.count()
	pending := call()
	link, err := url.Parse(text(pending["url"]))
	if err != nil || link == nil || link.Hostname() != "127.0.0.1" || pending["state"] != "user-choice-needs-browser" || pending["reason"] != "browser-confirmation" || pending["sideEffect"] != false {
		t.Fatal("connection did not return a local review", pending, err)
	}
	script := `import {chromium} from 'playwright';const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.goto(process.argv[1]);await page.getByRole('button',{name:'连接银河',exact:true}).click();await page.getByText('处理结果已返回。',{exact:true}).waitFor();console.log(JSON.stringify({confirmed:true}));}finally{await browser.close();}`
	if initializationNode(t, script, link.String())["confirmed"] != true || hostForms != 0 || transport.count() <= before {
		t.Fatal("the browser did not complete the original connection without a second tool call")
	}
	connected := uploadObject(call()["connection"])
	if text(connected["bindingId"]) == "" || hostForms != 0 {
		t.Fatal("confirmed connection did not complete", connected)
	}
	return &ConnectionSnapshot{BindingID: text(connected["bindingId"]), SubjectID: text(connected["subjectId"])}
}
