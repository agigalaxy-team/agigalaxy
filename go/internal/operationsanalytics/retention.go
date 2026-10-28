package operationsanalytics

import (
	"math"
	"sort"
	"time"
)

func cohortTime(v any) *int64 {
	s := str(v)
	if !cohortPattern.MatchString(s) {
		return nil
	}
	t, e := time.Parse("2006-01-02", s[:10])
	if e != nil || t.Format("2006-01-02") != s[:10] {
		return nil
	}
	n := t.Unix()
	return &n
}

// NormalizeRetention never turns native future-filled zero cells into an
// observed rate. Unknown native timezone retains the original day uncertainty.
func NormalizeRetention(value any, checkedAt int64, zone string) Object {
	input, ok := value.([]any)
	if !ok || len(input) > 100 || checkedAt < 0 {
		return nil
	}
	source := []Object{}
	width := 0
	for _, raw := range input {
		r := obj(raw)
		_, vok := r["values"].([]any)
		_, pok := r["percentages"].([]any)
		if r != nil && (r["cohort_interval"] == "Weighted Average" || cohortTime(r["cohort_interval"]) != nil) && vok && pok {
			source = append(source, r)
			for _, key := range []string{"values", "percentages"} {
				if n := len(list(r[key])); n > width {
					width = n
				}
			}
		}
	}
	if len(input) > 0 && len(source) == 0 {
		return nil
	}
	if width > 13 {
		width = 13
	}
	calendar, uncertain := checkedAt, true
	if zone != "" && zone != "Local" {
		if loc, e := time.LoadLocation(zone); e == nil {
			t := time.Unix(checkedAt, 0).In(loc)
			calendar = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC).Unix()
			uncertain = false
		}
	}
	age := func(r Object, edge string) *int64 {
		start := cohortTime(r["cohort_interval"])
		if start == nil {
			return nil
		}
		at := calendar
		if uncertain {
			if edge == "earliest" {
				at -= 86400
			} else {
				at += 86400
			}
		}
		v := int64(math.Floor(float64(at-*start) / (7 * 86400)))
		return &v
	}
	oldest := func(edge string) *int64 {
		var out *int64
		for _, r := range source {
			if r["cohort_interval"] == "Weighted Average" {
				continue
			}
			n := age(r, edge)
			if n != nil && (out == nil || *n > *out) {
				v := *n
				out = &v
			}
		}
		return out
	}
	weeks := []int{}
	for i := 0; i < width; i++ {
		weeks = append(weeks, i)
	}
	rows := []Object{}
	for _, r := range source {
		average := r["cohort_interval"] == "Weighted Average"
		earliest, last := age(r, "earliest"), age(r, "latest")
		if average {
			earliest, last = oldest("earliest"), oldest("latest")
		}
		size := number(r["sum"])
		cells := []Object{}
		values, pct := list(r["values"]), list(r["percentages"])
		for _, week := range weeks {
			cell := Object{"week": week, "count": nil, "ratio": nil, "state": "unknown"}
			if last != nil && earliest != nil {
				if int64(week) > *last {
					cell["state"] = "not-reached"
				} else if int64(week) <= *earliest {
					if week < len(values) {
						cell["count"] = number(values[week])
					}
					if week < len(pct) {
						rate, ok := num(pct[week])
						sum, sok := num(size)
						if ok && rate <= 1 && sok && sum > 0 {
							cell["ratio"], cell["state"] = rate, "recorded"
						}
					}
				}
			}
			cells = append(cells, cell)
		}
		rows = append(rows, Object{"cohort": r["cohort_interval"], "average": average, "size": size, "cells": cells})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i]["average"] != rows[j]["average"] {
			return rows[i]["average"] == true
		}
		return str(rows[i]["cohort"]) < str(rows[j]["cohort"])
	})
	return Object{"rows": rows, "weeks": weeks}
}
