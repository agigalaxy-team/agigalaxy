package jobs

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

type cronVector struct {
	Cron, Zone, From string
	Count            int
	Next             []string
	Previous         string
}

type cronHashVector struct {
	Fields []string
	Seed   uint32
	Values [][]int
}
type cronSyntaxVector struct {
	Cron  string
	Valid bool
}
type cronCapture struct {
	Preview          []cronVector
	Hash, Expansions []cronHashVector
	Syntax           []cronSyntaxVector
}

func loadCronVectors(t *testing.T) cronCapture {
	t.Helper()
	raw, e := os.ReadFile("testdata/cron-vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var v cronCapture
	if e = json.Unmarshal(raw, &v); e != nil {
		t.Fatal(e)
	}
	return v
}
func TestScheduleOriginalCronPreviewDSTAndExtensions(t *testing.T) {
	original := loadCronVectors(t).Preview
	s := &ScheduleQueue{}
	for _, v := range original {
		from, _ := time.Parse(time.RFC3339, v.From)
		next, e := s.PreviewSchedule(context.Background(), v.Cron, v.Zone, from, v.Count)
		if e != nil {
			t.Errorf("%s %s %s: %v", v.Cron, v.Zone, v.From, e)
			continue
		}
		actual := []string{}
		for _, n := range next {
			actual = append(actual, n.Format("2006-01-02T15:04:05.000Z"))
		}
		if !reflect.DeepEqual(actual, v.Next) {
			t.Errorf("%s %s %s next\nGo %v\nJS %v", v.Cron, v.Zone, v.From, actual, v.Next)
		}
		p, _ := parseSchedule(v.Cron, v.Zone)
		previous := p.previous(from).Format("2006-01-02T15:04:05.000Z")
		if previous != v.Previous {
			t.Errorf("%s %s %s previous Go %s JS %s", v.Cron, v.Zone, v.From, previous, v.Previous)
		}
	}
}
func TestScheduleOriginalUnseededHashExpansion(t *testing.T) {
	vectors := loadCronVectors(t)
	if len(vectors.Hash) != len(vectors.Expansions) {
		t.Fatal("missing hash vectors")
	}
	for i, v := range vectors.Hash {
		expanded, e := expandScheduleHash(v.Fields, v.Seed)
		if e != nil {
			t.Fatal(e)
		}
		expected := vectors.Expansions[i]
		if !reflect.DeepEqual(expanded, expected.Fields) || !reflect.DeepEqual(v.Values, expected.Values) {
			t.Errorf("seed %d expanded %v expected %v", v.Seed, expanded, expected.Fields)
		}
	}
}

func TestScheduleOriginalSyntaxAcceptanceAndReverseGap(t *testing.T) {
	original := loadCronVectors(t).Syntax
	for _, v := range original {
		_, e := parseSchedule(v.Cron, "UTC")
		if (e == nil) != v.Valid {
			t.Errorf("%s accepted Go %v JS %v", v.Cron, e == nil, v.Valid)
		}
	}
	p, e := parseSchedule("30 2 * * *", "America/New_York")
	if e != nil {
		t.Fatal(e)
	}
	from, _ := time.Parse(time.RFC3339, "2025-03-09T07:40:00Z")
	if v := p.previous(from).Format(time.RFC3339); v != "2025-03-08T07:30:00Z" {
		t.Fatalf("reverse fabricated spring gap %s", v)
	}
	p, _ = parseSchedule("15 2 * * *", "Australia/Lord_Howe")
	from, _ = time.Parse(time.RFC3339, "2025-10-04T16:40:00Z")
	if !p.previous(from).IsZero() {
		t.Fatal("reverse half-hour loop must preserve original failure")
	}
}
