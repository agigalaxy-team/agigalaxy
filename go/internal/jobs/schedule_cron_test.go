package jobs

import (
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

type cronVector struct {
	Cron, Zone, From string
	Count            int
	Next             []string
	Previous         string
}

func originalCron(t *testing.T, script string, input any, output any) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "../../..")
	raw, _ := json.Marshal(input)
	cmd := exec.Command("node", "--input-type=module", "-e", script, string(raw))
	cmd.Dir = root
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original cron-parser: %v %s", e, out)
	}
	if e = json.Unmarshal(out, output); e != nil {
		t.Fatalf("original output %s: %v", out, e)
	}
}
func TestScheduleOriginalCronPreviewDSTAndExtensions(t *testing.T) {
	vectors := []cronVector{}
	for _, expression := range []string{"0 0 * * 1-7/2", "0 0 * * THU", "0 0 * * 7/2", "0 0 * * 0-7", "0 0 */1 * MON", "0 0 ? * *"} {
		vectors = append(vectors, cronVector{Cron: expression, Zone: "UTC", From: "2025-01-01T00:00:00Z", Count: 5})
	}
	for _, entry := range [][2]string{{"America/New_York", "2025-03-09T06:58:59Z"}, {"America/New_York", "2025-11-02T05:58:59Z"}, {"Europe/Berlin", "2025-03-30T00:58:59Z"}, {"Europe/Berlin", "2025-10-26T00:58:59Z"}, {"Australia/Lord_Howe", "2025-04-05T14:58:59Z"}, {"Australia/Lord_Howe", "2025-10-04T15:28:59Z"}} {
		for _, expression := range []string{"* * * * *", "0 * * * *", "30 1 * * *", "0 2 * * *", "15 2 * * *", "*/15 2 * * *", "0 0-23 * * *", "* * * * * *"} {
			vectors = append(vectors, cronVector{Cron: expression, Zone: entry[0], From: entry[1], Count: 5})
		}
	}
	for _, expression := range []string{"*/15 * * * *", "5,35 12 * * MON-FRI", "*/7 * * * * *", "0 0 L * *", "0 0 1,L * *", "0 0 * * 1L", "0 0 * * MONL", "0 0 * * 1,3L", "0 0 * * 1#2", "0 0 * * SUN#2", "0 0 13 * 5", "0 0 29 2 *", "@daily", "@hourly", "0 0 ? JAN MON"} {
		vectors = append(vectors, cronVector{Cron: expression, Zone: "UTC", From: "2025-01-01T00:00:00Z", Count: 5})
	}
	for _, zone := range []string{"America/New_York", "Europe/Berlin", "Australia/Lord_Howe"} {
		for _, expression := range []string{"30 2 * * *", "30 1 * * *", "0 2,3 * * *", "*/15 2 * * *", "0 * * * *", "* * * * *"} {
			for _, from := range []string{"2025-03-08T08:00:00Z", "2025-11-01T08:00:00Z", "2025-11-02T06:15:00Z", "2025-10-04T12:00:00Z"} {
				vectors = append(vectors, cronVector{Cron: expression, Zone: zone, From: from, Count: 4})
			}
		}
	}
	var original []cronVector
	originalCron(t, `import{CronExpressionParser as C}from './packages/galaxy-official/node_modules/cron-parser/dist/index.js';let v=JSON.parse(process.argv[1]);for(let x of v){let p=C.parse(x.Cron,{tz:x.Zone,currentDate:x.From});x.Next=Array.from({length:x.Count},()=>p.next().toISOString());x.Previous=C.parse(x.Cron,{tz:x.Zone,currentDate:new Date(new Date(x.From).getTime()+1)}).prev().toISOString()}console.log(JSON.stringify(v))`, vectors, &original)
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
	fields := [][]string{{"H", "H/7", "H(1-6)/2", "H(10-99)", "H(1-20)/3", "H#3"}, {"H(0-1)/10", "H,H(30-59)", "H/50", "H/80", "H(0-20)", "H/3"}}
	type row struct {
		Fields []string
		Seed   uint32
		Values [][]int
	}
	rows := []row{}
	for _, f := range fields {
		for _, seed := range []uint32{1, 42, 987654321} {
			rows = append(rows, row{Fields: f, Seed: seed})
		}
	}
	var original []row
	originalCron(t, `import{CronExpressionParser as C}from './packages/galaxy-official/node_modules/cron-parser/dist/index.js';let v=JSON.parse(process.argv[1]);for(let x of v){Math.random=()=>x.Seed/1e10;let p=C.parse(x.Fields.join(' '),{tz:'UTC'});x.Values=['second','minute','hour','dayOfMonth','month','dayOfWeek'].map(k=>p.fields[k].values)}console.log(JSON.stringify(v))`, rows, &original)
	for _, v := range original {
		expanded, e := expandScheduleHash(v.Fields, v.Seed)
		if e != nil {
			t.Fatal(e)
		}
		var current []row
		originalCron(t, `import{CronExpressionParser as C}from './packages/galaxy-official/node_modules/cron-parser/dist/index.js';let v=JSON.parse(process.argv[1]);for(let x of v){let p=C.parse(x.Fields.join(' '),{tz:'UTC'});x.Values=['second','minute','hour','dayOfMonth','month','dayOfWeek'].map(k=>p.fields[k].values)}console.log(JSON.stringify(v))`, []row{{Fields: expanded}}, &current)
		if !reflect.DeepEqual(current[0].Values, v.Values) {
			t.Errorf("seed %d Go %v JS %v", v.Seed, current[0].Values, v.Values)
		}
	}
}

func TestScheduleOriginalSyntaxAcceptanceAndReverseGap(t *testing.T) {
	type syntax struct {
		Cron  string
		Valid bool
	}
	inputs := []syntax{}
	for _, expression := range []string{"0,0 * * * *", "0 0 * * 0,7", "0 0 L,L * *", "0 0 * * L", "0 0 * * 1L,1L", "0 0 * * 1#0", "0 0 * * 1#6", "0 0 * * MON#2", "0 0 L-3 * *", "0 0 * * 1-7/2", "0 0 * * 0-7", "0 0 * * 8", "0 0 * * 1#2,3", "0 0 * * 1#2#3", "0 0 * * 1,3L", "0 0 * * 0L", "0 0 * * 7L", "0 0 * * 7#3", "0 0 * * *#2", "0 0 * * 0L,7L", "0 0 29 FEB *", "0 0 * FOO *", "0 0 1W * *", "@secondly", "@minutely", "@yearly", "@every 5m", "1", "1 2", "0 0 ? * ?", "0 0 * * * * *", "H(100-200) * * * * *", "H/0 * * * * *"} {
		inputs = append(inputs, syntax{Cron: expression})
	}
	var original []syntax
	originalCron(t, `import{CronExpressionParser as C}from './packages/galaxy-official/node_modules/cron-parser/dist/index.js';let v=JSON.parse(process.argv[1]);for(let x of v){try{C.parse(x.Cron);x.Valid=true}catch{x.Valid=false}}console.log(JSON.stringify(v))`, inputs, &original)
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
