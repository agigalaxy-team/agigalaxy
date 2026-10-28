package jobs

import "time"

func scheduleHas(mask uint64, value int) bool { return mask&(uint64(1)<<uint(value)) != 0 }
func scheduleNearest(mask uint64, current int, reverse bool) int {
	if reverse {
		for i := current - 1; i >= 0; i-- {
			if scheduleHas(mask, i) {
				return i
			}
		}
	} else {
		for i := current + 1; i < 60; i++ {
			if scheduleHas(mask, i) {
				return i
			}
		}
	}
	return -1
}
func scheduleExtreme(mask uint64, reverse bool) int {
	if reverse {
		for i := 59; i >= 0; i-- {
			if scheduleHas(mask, i) {
				return i
			}
		}
	} else {
		for i := 0; i < 60; i++ {
			if scheduleHas(mask, i) {
				return i
			}
		}
	}
	return 0
}

// localSet has Luxon's existing-offset preference for ambiguous wall time, and
// carries nonexistent wall time forward by the offset gap. time.Date alone has
// a different (platform-independent but incompatible) choice at a DST gap.
func (p *scheduleCron) localSet(reference time.Time, y int, month time.Month, d, h, m, s int) time.Time {
	wall := time.Date(y, month, d, h, m, s, 0, time.UTC)
	_, preferred := reference.In(p.loc).Zone()
	offsets := []int{preferred}
	for _, delta := range []time.Duration{-48 * time.Hour, 48 * time.Hour} {
		_, o := reference.Add(delta).In(p.loc).Zone()
		offsets = append(offsets, o)
	}
	for _, o := range offsets {
		candidate := wall.Add(-time.Duration(o) * time.Second).In(p.loc)
		if candidate.Year() == wall.Year() && candidate.Month() == wall.Month() && candidate.Day() == wall.Day() && candidate.Hour() == wall.Hour() && candidate.Minute() == wall.Minute() && candidate.Second() == wall.Second() {
			return candidate
		}
	}
	// For a gap, prefer the pre-transition offset, which produces the forward
	// normalization rather than silently selecting the earlier wall clock.
	old := offsets[0]
	for _, o := range offsets {
		if o < old {
			old = o
		}
	}
	return wall.Add(-time.Duration(old) * time.Second).In(p.loc)
}
func (p *scheduleCron) setClock(reference time.Time, h, m, s int) time.Time {
	v := reference.In(p.loc)
	return p.localSet(v, v.Year(), v.Month(), v.Day(), h, m, s)
}
func (p *scheduleCron) next(from time.Time) time.Time {
	if !p.lastNext.Equal(from) {
		p.dstStart = -1
		p.dstLanding = -1
		p.dstEnd = -1
	}
	cur := from.In(p.loc).Truncate(time.Second)
	apply := func(unit time.Duration) {
		before := cur
		_, old := before.Zone()
		switch unit {
		case time.Hour:
			step := cur.Add(time.Hour)
			cur = p.setClock(step, step.Hour(), 0, 0)
		case time.Minute:
			cur = cur.Add(time.Minute).Truncate(time.Minute)
		default:
			cur = cur.Add(time.Second)
		}
		_, offset := cur.Zone()
		advance := (cur.Hour() - before.Hour() + 24) % 24
		if offset > old && advance >= 2 && p.spec.Hour&0xffffff != 0xffffff {
			p.dstStart = (before.Hour() + 1) % 24
			p.dstLanding = cur.Hour()
		} else if advance == 0 && cur.Minute() == 0 && cur.Second() == 0 && p.spec.Hour&0xffffff != 0xffffff {
			p.dstEnd = cur.Hour()
		}
	}
	nextDay := func() {
		v := cur.In(p.loc)
		date := time.Date(v.Year(), v.Month(), v.Day()+1, 0, 0, 0, 0, time.UTC)
		cur = p.localSet(v, date.Year(), date.Month(), date.Day(), 0, 0, 0)
	}
	if from.Nanosecond() > 0 {
		apply(time.Second)
	}
	for steps := 0; steps < 10000; steps++ {
		if !p.dayMatches(cur) {
			nextDay()
			continue
		}
		hour := cur.Hour()
		hourMatch := scheduleHas(p.spec.Hour, hour)
		gapMatch := false
		if p.dstStart >= 0 && p.dstLanding == hour {
			for skipped := p.dstStart; skipped != hour; skipped = (skipped + 1) % 24 {
				if scheduleHas(p.spec.Hour, skipped) {
					gapMatch = true
					break
				}
			}
		}
		if !gapMatch && p.dstEnd == hour {
			p.dstEnd = -1
			apply(time.Hour)
			continue
		}
		if !hourMatch && !gapMatch {
			p.dstStart = -1
			p.dstLanding = -1
			nextHour := scheduleNearest(p.spec.Hour, hour, false)
			if nextHour < 0 || nextHour > 23 {
				nextDay()
				continue
			}
			start := p.setClock(cur, 0, 0, 0)
			endDate := time.Date(cur.Year(), cur.Month(), cur.Day()+1, 0, 0, 0, 0, time.UTC)
			end := p.localSet(cur, endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0).Add(-time.Second)
			_, a := start.Zone()
			_, b := end.Zone()
			if a != b {
				for i := 0; i < nextHour-hour; i++ {
					apply(time.Hour)
					if cur.Hour() >= nextHour {
						break
					}
				}
			} else {
				cur = p.setClock(cur, nextHour, cur.Minute(), cur.Second())
			}
			cur = p.setClock(cur, cur.Hour(), scheduleExtreme(p.spec.Minute, false), scheduleExtreme(p.spec.Second, false))
			continue
		}
		if !scheduleHas(p.spec.Minute, cur.Minute()) {
			minute := scheduleNearest(p.spec.Minute, cur.Minute(), false)
			if minute >= 0 {
				cur = p.setClock(cur, cur.Hour(), minute, scheduleExtreme(p.spec.Second, false))
			} else {
				apply(time.Hour)
				cur = p.setClock(cur, cur.Hour(), scheduleExtreme(p.spec.Minute, false), scheduleExtreme(p.spec.Second, false))
			}
			continue
		}
		if !scheduleHas(p.spec.Second, cur.Second()) {
			second := scheduleNearest(p.spec.Second, cur.Second(), false)
			if second >= 0 {
				cur = p.setClock(cur, cur.Hour(), cur.Minute(), second)
			} else {
				apply(time.Minute)
				cur = p.setClock(cur, cur.Hour(), cur.Minute(), scheduleExtreme(p.spec.Second, false))
			}
			continue
		}
		if !cur.After(from) {
			apply(time.Second)
			continue
		}
		p.lastNext = cur.UTC()
		return p.lastNext
	}
	return time.Time{}
}

// The due pass uses a fresh reverse walk. In particular, reverse traversal does
// not manufacture a spring-forward occurrence which only the forward walk may
// have accepted. The same bounded loop preserves the original failure rather
// than silently inventing an occurrence at an unresolvable local transition.
func (p *scheduleCron) previous(from time.Time) time.Time {
	cur := from.In(p.loc).Truncate(time.Second)
	apply := func(unit time.Duration) {
		switch unit {
		case time.Hour:
			step := cur.Add(-time.Hour)
			cur = p.setClock(step, step.Hour(), 59, 59)
		case time.Minute:
			step := cur.Add(-time.Minute)
			cur = p.setClock(step, step.Hour(), step.Minute(), 59)
		default:
			cur = cur.Add(-time.Second)
		}
	}
	previousDay := func() {
		v := cur.In(p.loc)
		date := time.Date(v.Year(), v.Month(), v.Day()-1, 0, 0, 0, 0, time.UTC)
		cur = p.localSet(v, date.Year(), date.Month(), date.Day(), 23, 59, 59)
	}
	for steps := 0; steps < 10000; steps++ {
		if !p.dayMatches(cur) {
			previousDay()
			continue
		}
		if !scheduleHas(p.spec.Hour, cur.Hour()) {
			hour := cur.Hour()
			nextHour := scheduleNearest(p.spec.Hour, hour, true)
			if nextHour < 0 {
				previousDay()
				continue
			}
			start := p.setClock(cur, 0, 0, 0)
			endDate := time.Date(cur.Year(), cur.Month(), cur.Day()+1, 0, 0, 0, 0, time.UTC)
			end := p.localSet(cur, endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0).Add(-time.Second)
			_, a := start.Zone()
			_, b := end.Zone()
			if a != b {
				for i := 0; i < hour-nextHour; i++ {
					apply(time.Hour)
					if cur.Hour() <= nextHour {
						break
					}
				}
			} else {
				cur = p.setClock(cur, nextHour, cur.Minute(), cur.Second())
			}
			cur = p.setClock(cur, cur.Hour(), scheduleExtreme(p.spec.Minute, true), scheduleExtreme(p.spec.Second, true))
			continue
		}
		if !scheduleHas(p.spec.Minute, cur.Minute()) {
			minute := scheduleNearest(p.spec.Minute, cur.Minute(), true)
			if minute >= 0 {
				cur = p.setClock(cur, cur.Hour(), minute, scheduleExtreme(p.spec.Second, true))
			} else {
				apply(time.Hour)
				cur = p.setClock(cur, cur.Hour(), scheduleExtreme(p.spec.Minute, true), scheduleExtreme(p.spec.Second, true))
			}
			continue
		}
		if !scheduleHas(p.spec.Second, cur.Second()) {
			second := scheduleNearest(p.spec.Second, cur.Second(), true)
			if second >= 0 {
				cur = p.setClock(cur, cur.Hour(), cur.Minute(), second)
			} else {
				apply(time.Minute)
				cur = p.setClock(cur, cur.Hour(), cur.Minute(), scheduleExtreme(p.spec.Second, true))
			}
			continue
		}
		return cur.UTC()
	}
	return time.Time{}
}
