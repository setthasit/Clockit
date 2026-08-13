// Package tip holds the daily employer tip pool and its division among the
// members who worked that day (design §4.6).
package tip

import "sort"

// SplitByMinutes divides amountCents proportionally to minutes and returns one
// share per entry of minutes. Shares sum to exactly amountCents: plain
// per-member rounding loses or invents cents, so the fractions are settled by
// largest remainder instead — the leftover cents go one each to the largest
// remainders, breaking ties by larger minutes then by lower index so the same
// input always produces the same split.
//
// Integer arithmetic throughout: amountCents*minutes[i] peaks around 10^9 for
// realistic pools and 10^11 at the cap the PUT handler enforces, far inside
// int64, while float shares would not sum exactly.
//
// A zero total (no minutes worked, or an empty slice) yields all zeros — the
// tip is simply left unassigned in the report. Negative inputs are a caller
// bug, not a reachable state (the PUT handler bounds amount_cents to
// [0, maxTipCents] and minutes are derived from closed entries); they are
// clamped to zero rather than rejected, so a bad caller cannot hand someone a
// negative payout.
func SplitByMinutes(amountCents int64, minutes []int64) []int64 {
	shares := make([]int64, len(minutes))

	var total int64
	for _, m := range minutes {
		if m > 0 {
			total += m
		}
	}
	if amountCents <= 0 || total == 0 {
		return shares
	}

	type part struct {
		idx            int
		remainder, min int64
	}
	parts := make([]part, 0, len(minutes))
	leftover := amountCents
	for i, m := range minutes {
		if m <= 0 {
			continue
		}
		shares[i] = amountCents * m / total
		leftover -= shares[i]
		parts = append(parts, part{idx: i, remainder: amountCents * m % total, min: m})
	}

	sort.Slice(parts, func(a, b int) bool {
		if parts[a].remainder != parts[b].remainder {
			return parts[a].remainder > parts[b].remainder
		}
		if parts[a].min != parts[b].min {
			return parts[a].min > parts[b].min
		}
		return parts[a].idx < parts[b].idx
	})

	// Each floored share drops less than one cent, so leftover < len(parts).
	for _, p := range parts[:leftover] {
		shares[p.idx]++
	}
	return shares
}
