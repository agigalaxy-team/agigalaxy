package operationalmetrics

import (
	"bytes"
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/failureaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimelog"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/common/expfmt"
	"math"
	"strconv"
	"sync"
	"time"
)

type Options struct {
	Component             string
	Configuration         Configuration
	Pool                  *pgxpool.Pool
	Now                   func() time.Time
	Cache                 time.Duration
	DisableDefaultMetrics bool
	LogStatus             func() runtimelog.Status
}
type Metrics struct {
	Registry   *prometheus.Registry
	options    Options
	counters   map[string]*prometheus.CounterVec
	gauges     map[string]*prometheus.GaugeVec
	histograms map[string]*prometheus.HistogramVec
	mu         sync.Mutex
	last       time.Time
	attempted  bool
	pending    chan struct{}
}

func New(options Options) (*Metrics, error) {
	if !oneOf(options.Component, "api", "worker") || options.Cache < 0 || options.Cache > time.Minute {
		return nil, invalid()
	}
	if options.Cache == 0 {
		options.Cache = 15 * time.Second
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if e := validateCost(options.Configuration.Cost); e != nil {
		return nil, e
	}
	if options.Configuration.CostFile != "" {
		if _, e := ReadCost(options.Configuration.CostFile); e != nil {
			return nil, e
		}
	}
	m := &Metrics{Registry: prometheus.NewRegistry(), options: options, counters: map[string]*prometheus.CounterVec{}, gauges: map[string]*prometheus.GaugeVec{}, histograms: map[string]*prometheus.HistogramVec{}}
	labels := prometheus.Labels{"component": options.Component}
	for _, s := range metricSpecs {
		if len(s.name) > 9 && s.name[:9] == "autonomy_" && options.Pool == nil {
			continue
		}
		if oneOf(s.name, "cost_amount", "cost_budget", "cost_scope_info", "cost_period_start_timestamp_seconds", "cost_period_end_timestamp_seconds", "cost_observed_timestamp_seconds", "cost_last_success_timestamp_seconds") && options.Configuration.Cost == nil && options.Configuration.CostFile == "" {
			continue
		}
		switch s.kind {
		case "counter":
			v := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "galaxy_" + s.name, Help: s.help, ConstLabels: labels}, s.labels)
			m.counters[s.name] = v
			m.Registry.MustRegister(v)
		case "gauge":
			v := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "galaxy_" + s.name, Help: s.help, ConstLabels: labels}, s.labels)
			m.gauges[s.name] = v
			m.Registry.MustRegister(v)
		case "histogram":
			v := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "galaxy_" + s.name, Help: s.help, ConstLabels: labels, Buckets: []float64{0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10, 30}}, s.labels)
			m.histograms[s.name] = v
			m.Registry.MustRegister(v)
		}
	}
	if !options.DisableDefaultMetrics {
		register := prometheus.WrapRegistererWith(labels, prometheus.WrapRegistererWithPrefix("galaxy_", m.Registry))
		register.MustRegister(prometheus.NewGoCollector(), prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))
	}
	for _, name := range []string{"http_in_flight", "worker_last_iteration_timestamp_seconds", "worker_retirement_paused", "verified_capability_measurement_available"} {
		m.set(name, 0)
	}
	m.set("backup_collection_enabled", flag(options.Configuration.BackupStatusDirectory != ""))
	m.set("database_collection_enabled", flag(options.Pool != nil))
	m.set("storage_collection_enabled", flag(options.Configuration.StorageDirectory != ""))
	m.set("cost_collection_enabled", flag(options.Configuration.CostFile != "" || options.Configuration.Cost != nil))
	m.updateCost(options.Configuration.Cost)
	return m, nil
}
func flag(value bool) float64 {
	if value {
		return 1
	}
	return 0
}
func (m *Metrics) set(name string, value float64, labels ...string) {
	if metric := m.gauges[name]; metric != nil {
		metric.WithLabelValues(labels...).Set(value)
	}
}
func (m *Metrics) remove(name string, labels ...string) {
	if metric := m.gauges[name]; metric != nil {
		metric.DeleteLabelValues(labels...)
	}
}
func (m *Metrics) reset(names ...string) {
	for _, name := range names {
		if metric := m.gauges[name]; metric != nil {
			metric.Reset()
		}
	}
}
func (m *Metrics) BuilderProbe(processed bool, state string) {
	if processed && oneOf(state, "reachable", "authentication-required", "protocol-mismatch", "unavailable", "revoked") {
		m.counters["builder_probe_observations_total"].WithLabelValues(state).Inc()
	}
}
func (m *Metrics) QuotaRejected(code string) {
	kind := map[string]string{"storage_quota_exceeded": "payload", "job_queue_quota_exceeded": "queue", "export_ticket_quota_exceeded": "exports", "rate_limited": "request_rate"}[code]
	if kind != "" {
		m.counters["resource_quota_rejections_total"].WithLabelValues(kind).Inc()
	}
}

type HTTPResult struct {
	Method, Path                 string
	Status                       int
	BodyBytes, ReceivedBodyBytes float64
}

func (m *Metrics) BeginHTTP() func(HTTPResult) {
	started := time.Now()
	m.gauges["http_in_flight"].WithLabelValues().Inc()
	var once sync.Once
	return func(result HTTPResult) {
		once.Do(func() {
			m.gauges["http_in_flight"].WithLabelValues().Dec()
			route := failureaudit.FailureRoute(result.Method, result.Path)
			status := "499"
			if result.Status >= 100 && result.Status <= 599 {
				status = strconv.Itoa(result.Status)
			}
			seconds := math.Max(0, time.Since(started).Seconds())
			m.counters["http_requests_total"].WithLabelValues(route, status).Inc()
			m.histograms["http_request_duration_seconds"].WithLabelValues(route, status).Observe(seconds)
			if finite(result.BodyBytes) {
				m.counters["http_response_body_bytes_total"].WithLabelValues(route).Add(result.BodyBytes)
			}
			if finite(result.ReceivedBodyBytes) {
				m.counters["http_request_body_bytes_total"].WithLabelValues(route).Add(result.ReceivedBodyBytes)
			}
			if status[0] == '2' && len(route) >= 7 && route[len(route)-7:] == "/revoke" {
				m.histograms["revocation_ack_duration_seconds"].WithLabelValues(route).Observe(seconds)
			}
		})
	}
}
func (m *Metrics) ParserError(status int) {
	if !oneOf(strconv.Itoa(status), "400", "408", "431") {
		status = 400
	}
	m.counters["http_parser_errors_total"].WithLabelValues(strconv.Itoa(status)).Inc()
}

type WorkerResult struct {
	Processed, BudgetLimited, LeaseLost bool
	State                               string
}

func (m *Metrics) WorkerIteration(result WorkerResult, seconds float64, failed, paused bool) {
	outcome := "idle"
	if failed {
		outcome = "error"
	} else if paused {
		outcome = "paused"
	} else if result.BudgetLimited {
		outcome = "budget_limited"
	} else if result.LeaseLost {
		outcome = "lease_lost"
	} else if result.Processed && oneOf(result.State, "observed", "revoked", "unavailable") {
		outcome = result.State
	}
	m.counters["worker_iterations_total"].WithLabelValues(outcome).Inc()
	if !finite(seconds) {
		seconds = 0
	}
	m.histograms["worker_iteration_duration_seconds"].WithLabelValues(outcome).Observe(seconds)
	m.set("worker_last_iteration_timestamp_seconds", float64(m.options.Now().UnixMilli())/1000)
	m.set("worker_retirement_paused", flag(paused))
}
func (m *Metrics) Render(ctx context.Context) (string, error) {
	if e := m.refresh(ctx); e != nil {
		return "", e
	}
	families, e := m.Registry.Gather()
	if e != nil {
		return "", invalid()
	}
	var body bytes.Buffer
	for _, family := range families {
		if _, e = expfmt.MetricFamilyToText(&body, family); e != nil {
			return "", invalid()
		}
	}
	return body.String(), nil
}
func (m *Metrics) refresh(ctx context.Context) error {
	m.mu.Lock()
	if m.pending != nil {
		done := m.pending
		m.mu.Unlock()
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	now := m.options.Now()
	if m.attempted && now.Sub(m.last) < m.options.Cache {
		m.mu.Unlock()
		return nil
	}
	m.last = now
	m.attempted = true
	done := make(chan struct{})
	m.pending = done
	m.mu.Unlock()
	go func() {
		defer func() { m.mu.Lock(); m.pending = nil; close(done); m.mu.Unlock() }()
		c, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		m.collect(c, now)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (m *Metrics) updateCost(value *CostInput) {
	m.set("cost_input_available", flag(value != nil))
	m.set("cost_budget_configured", flag(value != nil && value.Budget != nil))
	if m.gauges["cost_amount"] == nil {
		return
	}
	m.reset("cost_amount", "cost_budget", "cost_scope_info")
	for _, name := range []string{"cost_period_start_timestamp_seconds", "cost_period_end_timestamp_seconds", "cost_observed_timestamp_seconds"} {
		m.remove(name)
	}
	if value == nil {
		return
	}
	m.set("cost_amount", value.Amount, value.Currency, value.Kind)
	if value.Budget != nil {
		m.set("cost_budget", *value.Budget, value.Currency, value.Kind)
	}
	if s := value.Scope; s != nil {
		m.set("cost_scope_info", 1, s.Dimension, strconv.Itoa(s.Count), s.SHA256, s.Attribution)
	}
	for name, value := range map[string]string{"cost_period_start_timestamp_seconds": value.PeriodStart, "cost_period_end_timestamp_seconds": value.PeriodEnd, "cost_observed_timestamp_seconds": value.ObservedAt} {
		at, _ := date(value)
		m.set(name, float64(at.UnixMilli())/1000)
	}
	m.set("cost_last_success_timestamp_seconds", float64(m.options.Now().UnixMilli())/1000)
}
