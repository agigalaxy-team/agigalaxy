package jobs

import (
	"math"
	"math/rand/v2"
	"regexp"
	"strconv"
	"strings"
)

var scheduleHashed = regexp.MustCompile(`H(?:\((\d+)-(\d+)\))?(?:/(\d+))?`)

// The original caller supplies no hashSeed. Preserve its randomly seeded
// mulberry32 expansion, including one correlated draw per field (not one per H).
// seed is explicit here solely so differential tests can use the original PRNG.
func expandScheduleHash(fields []string, seed uint32) ([]string, error) {
	result := append([]string{}, fields...)
	bounds := [][2]int{{0, 59}, {0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}
	for _, i := range []int{0, 1, 2, 4, 3, 5} {
		seed += 0x6d2b79f5
		t := seed
		t = (t ^ (t >> 15)) * (t | 1)
		t ^= t + (t^(t>>7))*(t|61)
		random := float64(t^(t>>14)) / 4294967296
		invalid := false
		result[i] = scheduleHashed.ReplaceAllStringFunc(fields[i], func(token string) string {
			parts := scheduleHashed.FindStringSubmatch(token)
			lo, hi := bounds[i][0], bounds[i][1]
			if parts[1] != "" {
				a, e := strconv.Atoi(parts[1])
				b, e2 := strconv.Atoi(parts[2])
				if e != nil || e2 != nil || a > b {
					invalid = true
					return token
				}
				lo = max(lo, a)
				hi = min(hi, b)
				if lo > hi {
					invalid = true
					return token
				}
			}
			hashed := func() string { return strconv.Itoa(int(math.Floor(random*float64(hi-lo+1))) + lo) }
			if parts[3] == "" {
				return hashed()
			}
			step, e := strconv.Atoi(parts[3])
			if e != nil || step < 1 {
				invalid = true
				return token
			}
			if (hi-lo)/step+1 > 256 {
				invalid = true
				return token
			}
			offset := int(math.Floor(random * float64(step)))
			values := []string{}
			for n := lo/step*step + offset; n <= hi; n += step {
				if n >= lo {
					values = append(values, strconv.Itoa(n))
				}
			}
			if len(values) == 0 {
				return hashed()
			}
			return strings.Join(values, ",")
		})
		if invalid {
			return nil, scheduleInvalid()
		}
	}
	return result, nil
}
func scheduleRandomSeed() uint32 { return uint32(rand.Int64N(10_000_000_000)) }
