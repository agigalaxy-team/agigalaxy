package operationalmetrics

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimelog"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func metric(t *testing.T, registry *prometheus.Registry, name string, labels map[string]string) (float64, bool) {
	t.Helper()
	families, e := registry.Gather()
	if e != nil {
		t.Fatal(e)
	}
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, m := range family.GetMetric() {
			match := true
			for k, v := range labels {
				found := false
				for _, l := range m.GetLabel() {
					if l.GetName() == k && l.GetValue() == v {
						found = true
					}
				}
				if !found {
					match = false
				}
			}
			if match {
				if m.GetGauge() != nil {
					return m.GetGauge().GetValue(), true
				}
				if m.GetCounter() != nil {
					return m.GetCounter().GetValue(), true
				}
				if m.GetHistogram() != nil {
					return float64(m.GetHistogram().GetSampleCount()), true
				}
			}
		}
	}
	return 0, false
}
func expect(t *testing.T, m *Metrics, name string, labels map[string]string, value float64) {
	t.Helper()
	got, ok := metric(t, m.Registry, "galaxy_"+name, labels)
	if !ok || got != value {
		t.Fatalf("%s %v: %v/%v expected %v", name, labels, got, ok, value)
	}
}
func node(t *testing.T, script string, env []string, args ...string) []byte {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", append([]string{"--no-warnings", "--input-type=module", "-e", script}, args...)...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), env...)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original JS: %v %s", e, out)
	}
	return out
}
func TestOriginalMetricsEventValuesAndNoPrivateLabels(t *testing.T) {
	m, e := New(Options{Component: "api", DisableDefaultMetrics: true})
	if e != nil {
		t.Fatal(e)
	}
	finish := m.BeginHTTP()
	finish(HTTPResult{Method: "POST", Path: "/v1/proofs/11111111-1111-4111-8111-111111111111/revoke", Status: 200, BodyBytes: 17, ReceivedBodyBytes: 11})
	finish(HTTPResult{Status: 500})
	finish = m.BeginHTTP()
	finish(HTTPResult{Method: "DELETE", Path: "/PRIVATE-PATH?token=PRIVATE", Status: 999, BodyBytes: 3})
	m.QuotaRejected("rate_limited")
	m.QuotaRejected("PRIVATE")
	m.ParserError(431)
	m.BuilderProbe(true, "reachable")
	m.WorkerIteration(WorkerResult{Processed: true, State: "observed"}, 0.1, false, false)
	body, e := m.Render(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(body, "PRIVATE") || strings.Contains(body, "nodejs") || strings.Contains(body, "galaxy_go_") {
		t.Fatal("private or fabricated default data")
	}
	expect(t, m, "http_requests_total", map[string]string{"route": "POST /v1/proofs/:id/revoke", "status": "200"}, 1)
	expect(t, m, "http_requests_total", map[string]string{"route": "http.request", "status": "499"}, 1)
	expect(t, m, "http_response_body_bytes_total", map[string]string{"route": "POST /v1/proofs/:id/revoke"}, 17)
	expect(t, m, "http_request_body_bytes_total", map[string]string{"route": "POST /v1/proofs/:id/revoke"}, 11)
	expect(t, m, "http_in_flight", nil, 0)
	expect(t, m, "revocation_ack_duration_seconds", nil, 1)
	expect(t, m, "worker_iterations_total", map[string]string{"outcome": "observed"}, 1)
	script := `import {createOperationalMetrics} from './packages/galaxy-official/src/operations/metrics.mjs';const m=createOperationalMetrics({component:'api',defaultMetrics:false});let f=m.beginHttp();f({method:'POST',path:'/v1/proofs/11111111-1111-4111-8111-111111111111/revoke',status:200,bodyBytes:17,receivedBodyBytes:11});f({status:500});f=m.beginHttp();f({method:'DELETE',path:'/PRIVATE-PATH?token=PRIVATE',status:999,bodyBytes:3});m.quotaRejected('rate_limited');m.quotaRejected('PRIVATE');m.parserError(431);m.builderProbe({processed:true,state:'reachable'});m.workerIteration({processed:true,state:'observed'},0.1);console.log(await m.render());`
	original := string(node(t, script, nil))
	compareOriginalSamples(t, m, original, map[string]bool{"galaxy_worker_last_iteration_timestamp_seconds": true})

}
func TestExplicitCostBackupDiskAndSingleFlightFailureRemoval(t *testing.T) {
	dir := t.TempDir()
	costFile := filepath.Join(dir, "cost.json")
	cost := `{"version":2,"currency":"USD","kind":"operator-estimate","amount":12.5,"budget":null,"periodStart":"2030-01-01T00:00:00Z","periodEnd":"2030-02-01T00:00:00Z","observedAt":"2030-01-15T00:00:00Z","scope":{"dimension":"resourceId","count":2,"sha256":"` + strings.Repeat("a", 64) + `","attribution":"unallocated"}}`
	os.WriteFile(costFile, []byte(cost), 0600)
	backup := `{"version":1,"action":"create","runId":"11111111-1111-4111-8111-111111111111","startedAt":100,"finishedAt":110,"outcome":"succeeded","lastSuccessAt":110}`
	os.WriteFile(filepath.Join(dir, "create.json"), []byte(backup), 0600)
	env := map[string]string{"GALAXY_METRICS_COST_FILE": costFile, "GALAXY_METRICS_STORAGE_DIRECTORY": dir, "GALAXY_BACKUP_STATUS_DIRECTORY": dir}
	c, e := LoadConfiguration(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if e != nil {
		t.Fatal(e)
	}
	var ticks atomic.Int64
	ticks.Store(time.Date(2030, 1, 15, 0, 0, 0, 0, time.UTC).UnixMilli())
	var refreshes atomic.Int32
	m, e := New(Options{Component: "api", Configuration: c, DisableDefaultMetrics: true, Now: func() time.Time { return time.UnixMilli(ticks.Load()) }, LogStatus: func() runtimelog.Status {
		refreshes.Add(1)
		return runtimelog.Status{Ready: false, WriteFailures: 1, DroppedRecords: 2}
	}})
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := m.Render(context.Background()); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if refreshes.Load() != 1 {
		t.Fatal("not singleflight/cache", refreshes.Load())
	}
	expect(t, m, "cost_input_available", nil, 1)
	expect(t, m, "cost_budget_configured", nil, 0)
	expect(t, m, "cost_amount", map[string]string{"currency": "USD", "kind": "operator-estimate"}, 12.5)
	expect(t, m, "backup_last_attempt_success", map[string]string{"action": "create"}, 1)
	expect(t, m, "backup_status_available", map[string]string{"action": "copy"}, 0)
	expect(t, m, "storage_collection_success", nil, 1)
	expect(t, m, "runtime_log_events", map[string]string{"kind": "writeFailures"}, 1)
	script := `import {loadMetricsConfiguration,createOperationalMetrics} from './packages/galaxy-official/src/operations/metrics.mjs';const c=await loadMetricsConfiguration({GALAXY_METRICS_COST_FILE:process.argv[1],GALAXY_METRICS_STORAGE_DIRECTORY:process.argv[2],GALAXY_BACKUP_STATUS_DIRECTORY:process.argv[2]});const m=createOperationalMetrics({component:'api',...c,defaultMetrics:false,now:()=>Date.parse('2030-01-15T00:00:00Z'),logStatus:()=>({ready:false,writeFailures:1,droppedRecords:2,rotationWarnings:0,rotations:0})});console.log(await m.render());`
	original := string(node(t, script, nil, costFile, dir))
	compareOriginalSamples(t, m, original, map[string]bool{"galaxy_storage_bytes": true})

	os.WriteFile(costFile, []byte(`{"PRIVATE":"DO-NOT-LOG"}`), 0600)
	os.WriteFile(filepath.Join(dir, "create.json"), []byte("PRIVATE"), 0600)
	ticks.Add(16000)
	body, e := m.Render(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	expect(t, m, "cost_input_available", nil, 0)
	expect(t, m, "cost_budget_configured", nil, 0)
	expect(t, m, "backup_status_available", map[string]string{"action": "create"}, 0)
	if _, ok := metric(t, m.Registry, "galaxy_cost_amount", nil); ok {
		t.Fatal("stale cost retained")
	}
	if strings.Contains(body, "PRIVATE") {
		t.Fatal("private input leaked")
	}
	if refreshes.Load() != 2 {
		t.Fatal("cache never refreshes")
	}
}
func TestActualLoopbackMetricsListenerAndRealGoDefaults(t *testing.T) {
	m, e := New(Options{Component: "worker"})
	if e != nil {
		t.Fatal(e)
	}
	port := 0
	l, e := StartListener(m, &port)
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	if !strings.HasPrefix(l.Addr().String(), "127.0.0.1:") {
		t.Fatal("public bind")
	}
	url := "http://" + l.Addr().String()
	response, e := http.Get(url + "/metrics")
	if e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(body), "galaxy_go_goroutines") || strings.Contains(string(body), "nodejs") {
		t.Fatal("default metrics not actual Go", string(body))
	}
	for _, path := range []string{"/metrics?token=PRIVATE", "/PRIVATE"} {
		r, e := http.Get(url + path)
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		if r.StatusCode != 404 {
			t.Fatal("listener broadened routes")
		}
	}
	if e = l.Close(); e != nil {
		t.Fatal(e)
	}
	client := http.Client{Timeout: 100 * time.Millisecond}
	if r, e := client.Get(url + "/metrics"); e == nil {
		r.Body.Close()
		t.Fatal("listener retained after close")
	}
}
func TestActualPostgresSnapshotOriginalParityAndUnavailableRemoval(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {migrate} from './packages/galaxy-official/src/infrastructure/database.mjs';import {operationalSnapshot} from './packages/galaxy-official/src/infrastructure/operational-snapshot.mjs';const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated DB required');const db=new pg.Pool({connectionString:url.href});try{await migrate(db);console.log(JSON.stringify(await operationalSnapshot(db,2000000000000)))}finally{await db.end()}`
	var original map[string]float64
	if e := json.Unmarshal(node(t, script, []string{"GALAXY_GO_TEST_DATABASE_URL=" + dsn}), &original); e != nil {
		t.Fatal(e)
	}
	at := time.Unix(2000000000, 0)
	values, e := operationalSnapshot(context.Background(), pool, at)
	if e != nil {
		t.Fatal(e)
	}
	for key, value := range original {
		if key != "database_bytes" && values[key] != value {
			t.Fatal("aggregate parity", key, value, values[key])
		}
	}
	if values["database_bytes"] <= 0 {
		t.Fatal("database bytes unavailable")
	}
	var tick atomic.Int64
	tick.Store(at.UnixMilli())
	m, e := New(Options{Component: "api", Pool: pool, DisableDefaultMetrics: true, Now: func() time.Time { return time.UnixMilli(tick.Load()) }})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Render(context.Background()); e != nil {
		t.Fatal(e)
	}
	expect(t, m, "database_collection_success", nil, 1)
	expect(t, m, "autonomy_collection_success", nil, 1)
	expect(t, m, "product_subjects", map[string]string{"stage": "connected"}, 0)
	if _, e = pool.Exec(context.Background(), "ALTER TABLE jobs RENAME TO jobs_hidden"); e != nil {
		t.Fatal(e)
	}
	tick.Add(16000)
	m.Render(context.Background())
	expect(t, m, "database_collection_success", nil, 0)
	if _, ok := metric(t, m.Registry, "galaxy_database_bytes", nil); ok {
		t.Fatal("stale DB aggregate retained")
	}
	if _, e = pool.Exec(context.Background(), "ALTER TABLE jobs_hidden RENAME TO jobs"); e != nil {
		t.Fatal(e)
	}
	tick.Add(16000)
	m.Render(context.Background())
	expect(t, m, "database_collection_success", nil, 1)
}

func sampleValues(families []*dto.MetricFamily, skip map[string]bool) map[string]float64 {
	out := map[string]float64{}
	for _, family := range families {
		if skip[family.GetName()] {
			continue
		}
		for _, metric := range family.GetMetric() {
			labels := []string{}
			for _, label := range metric.GetLabel() {
				labels = append(labels, label.GetName()+"="+label.GetValue())
			}
			sort.Strings(labels)
			key := family.GetName() + "{" + strings.Join(labels, ",") + "}"
			if metric.GetGauge() != nil {
				out[key] = metric.GetGauge().GetValue()
			} else if metric.GetCounter() != nil {
				out[key] = metric.GetCounter().GetValue()
			} else if metric.GetHistogram() != nil {
				out[key+"_count"] = float64(metric.GetHistogram().GetSampleCount())
			}
		}
	}
	return out
}
func compareOriginalSamples(t *testing.T, m *Metrics, original string, skip map[string]bool) {
	t.Helper()
	parser := expfmt.NewTextParser(model.LegacyValidation)
	values, e := parser.TextToMetricFamilies(strings.NewReader(original))
	if e != nil {
		t.Fatal(e)
	}
	families := []*dto.MetricFamily{}
	for _, family := range values {
		families = append(families, family)
	}
	expected := sampleValues(families, skip)
	gathered, e := m.Registry.Gather()
	if e != nil {
		t.Fatal(e)
	}
	actual := sampleValues(gathered, skip)
	for key, value := range expected {
		got, ok := actual[key]
		if !ok || got != value {
			t.Fatalf("original sample %s: %v/%v != %v", key, got, ok, value)
		}
	}
}
