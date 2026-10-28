package jobs

import (
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/robfig/cron/v3"
)

// robfig supplies the ordinary field grammar, not its runner or DST policy.
// cron-parser's local gap/fold policy differs from robfig.Next. We construct the
// selected wall-clock times explicitly and map them through the location rules.
type scheduleCron struct {
	spec                         *cron.SpecSchedule
	loc                          *time.Location
	domLast                      bool
	domMask, dowMask             uint64
	lastWeekdays                 []int
	nthWeekday, nth              int
	domAny, dowAny               bool
	dstStart, dstLanding, dstEnd int
	lastNext                     time.Time
}

const scheduleStar = uint64(1) << 63

func parseSchedule(expression, zone string) (*scheduleCron, error) {
	if expression == "" || len(expression) > 160 || strings.TrimSpace(zone) == "" || strings.HasPrefix(expression, "RRULE:") || strings.HasPrefix(expression, "DTSTART:") {
		return nil, scheduleInvalid()
	}
	loc, e := time.LoadLocation(zone)
	if e != nil || zone == "Local" {
		return nil, scheduleInvalid()
	}
	aliases := map[string]string{"@yearly": "0 0 0 1 1 *", "@annually": "0 0 0 1 1 *", "@monthly": "0 0 0 1 * *", "@weekly": "0 0 0 * * 0", "@daily": "0 0 0 * * *", "@midnight": "0 0 0 * * *", "@hourly": "0 0 * * * *", "@minutely": "0 * * * * *", "@secondly": "* * * * * *"}
	if value, ok := aliases[expression]; ok {
		expression = value
	}
	fields := strings.Fields(expression)
	if len(fields) < 1 || len(fields) > 6 {
		return nil, scheduleInvalid()
	}
	defaults := []string{"0", "*", "*", "*", "*", "*"}
	fields = append(append([]string{}, defaults[:6-len(fields)]...), fields...)
	for name, value := range map[string]string{"SUN": "0", "MON": "1", "TUE": "2", "WED": "3", "THU": "4", "FRI": "5", "SAT": "6"} {
		fields[5] = strings.ReplaceAll(strings.ToUpper(fields[5]), name, value)
	}
	fields, e = expandScheduleHash(fields, scheduleRandomSeed())
	if e != nil {
		return nil, e
	}
	if e = scheduleNoDuplicateFields(fields); e != nil {
		return nil, e
	}
	p := &scheduleCron{loc: loc, nthWeekday: -1, domAny: fields[3] == "*" || fields[3] == "?", dowAny: fields[5] == "*" || fields[5] == "?"}
	dom := []string{}
	for _, part := range strings.Split(fields[3], ",") {
		if part == "L" {
			p.domLast = true
		} else {
			dom = append(dom, part)
		}
	}
	if len(dom) == 0 {
		fields[3] = "*"
	} else {
		fields[3] = strings.Join(dom, ",")
	}
	dow := []string{}
	seenLast := map[string]bool{}
	for _, part := range strings.Split(fields[5], ",") {
		if strings.HasSuffix(part, "L") {
			v, err := strconv.Atoi(strings.TrimSuffix(part, "L"))
			if err != nil || v < 0 || v > 7 {
				return nil, scheduleInvalid()
			}
			if seenLast[part] {
				return nil, scheduleInvalid()
			}
			seenLast[part] = true
			p.lastWeekdays = append(p.lastWeekdays, v%7)
		} else if strings.Contains(part, "#") {
			a := strings.Split(part, "#")
			if len(a) != 2 || len(strings.Split(fields[5], ",")) != 1 {
				return nil, scheduleInvalid()
			}
			v, err := strconv.Atoi(a[0])
			if a[0] == "*" || a[0] == "?" {
				v = -2
				err = nil
			}
			n, err2 := strconv.Atoi(a[1])
			if err != nil || err2 != nil || v < -2 || v == -1 || v > 7 || n < 1 || n > 5 {
				return nil, scheduleInvalid()
			}
			p.nthWeekday = v % 7
			p.nth = n
		} else {
			dow = append(dow, part)
		}
	}
	if len(dow) == 0 {
		fields[5] = "*"
	} else {
		p.dowMask, e = scheduleWeekdayMask(dow)
		if e != nil {
			return nil, e
		}
		fields[5] = "*"
	}
	parser := cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	value, e := parser.Parse(strings.Join(fields, " "))
	if e != nil {
		return nil, scheduleInvalid()
	}
	p.spec = value.(*cron.SpecSchedule)
	if len(dom) > 0 {
		p.domMask = p.spec.Dom
	}
	return p, nil
}
func scheduleWeekdayMask(parts []string) (uint64, error) {
	var mask uint64
	for _, part := range parts {
		var atomMask uint64
		atoms := strings.Split(part, "/")
		if len(atoms) > 2 {
			return 0, scheduleInvalid()
		}
		step := 1
		if len(atoms) == 2 {
			v, e := strconv.Atoi(atoms[1])
			if e != nil || v < 1 {
				return 0, scheduleInvalid()
			}
			step = v
		}
		lo, hi := 0, 7
		if atoms[0] != "*" && atoms[0] != "?" {
			bounds := strings.Split(atoms[0], "-")
			if len(bounds) > 2 {
				return 0, scheduleInvalid()
			}
			v, e := strconv.Atoi(bounds[0])
			if e != nil {
				return 0, scheduleInvalid()
			}
			lo = v
			hi = v
			if len(bounds) == 2 {
				hi, e = strconv.Atoi(bounds[1])
				if e != nil {
					return 0, scheduleInvalid()
				}
			} else if len(atoms) == 2 {
				hi = 7
			}
		}
		if lo < 0 || hi > 7 || lo > hi {
			return 0, scheduleInvalid()
		}
		for v := lo; v <= hi; v += step {
			atomMask |= uint64(1) << uint(v%7)
		}
		if mask&atomMask != 0 {
			return 0, scheduleInvalid()
		}
		mask |= atomMask
	}
	return mask, nil
}

func scheduleNoDuplicateFields(fields []string) error {
	parser := cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	for i, field := range fields {
		if i == 5 {
			continue
		}
		var used uint64
		last := false
		for _, part := range strings.Split(field, ",") {
			if i == 3 && part == "L" {
				if last {
					return scheduleInvalid()
				}
				last = true
				continue
			}
			values := []string{"0", "0", "0", "*", "*", "*"}
			values[i] = part
			v, e := parser.Parse(strings.Join(values, " "))
			if e != nil {
				return scheduleInvalid()
			}
			s := v.(*cron.SpecSchedule)
			mask := []uint64{s.Second, s.Minute, s.Hour, s.Dom, s.Month, s.Dow}[i] &^ scheduleStar
			if used&mask != 0 {
				return scheduleInvalid()
			}
			used |= mask
		}
	}
	return nil
}
func (p *scheduleCron) dayMatches(d time.Time) bool {
	if p.spec.Month&(uint64(1)<<uint(d.Month())) == 0 {
		return false
	}
	last := time.Date(d.Year(), d.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	dom := p.domMask&(uint64(1)<<uint(d.Day())) != 0 || p.domLast && d.Day() == last
	dow := p.dowMask&(uint64(1)<<uint(d.Weekday())) != 0
	for _, v := range p.lastWeekdays {
		if int(d.Weekday()) == v && d.Day()+7 > last {
			dow = true
		}
	}
	if (int(d.Weekday()) == p.nthWeekday || p.nthWeekday == -2) && (d.Day()-1)/7+1 == p.nth {
		dow = true
	}
	if p.domAny {
		return dow
	}
	if p.dowAny {
		return dom
	}
	return dom || dow
}
