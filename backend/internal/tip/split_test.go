package tip

import (
	"math/rand/v2"
	"slices"
	"testing"
)

func TestSplitByMinutes(t *testing.T) {
	cases := []struct {
		name    string
		amount  int64
		minutes []int64
		want    []int64
	}{
		{"equal shares, one cent left over", 100, []int64{30, 30, 30}, []int64{34, 33, 33}},
		{"sole member takes the pool", 100, []int64{45}, []int64{100}},
		{"member who did not work gets nothing", 100, []int64{0, 45}, []int64{0, 100}},
		{"nobody worked, tip stays unassigned", 100, []int64{0, 0}, []int64{0, 0}},
		{"no members", 100, nil, []int64{}},
		{"no tip", 0, []int64{30, 60}, []int64{0, 0}},
		{"exact division needs no remainder pass", 100, []int64{30, 10}, []int64{75, 25}},
		{"leftover cent to the largest remainder", 101, []int64{60, 30}, []int64{67, 34}},
		{"equal remainders break toward larger minutes", 10, []int64{3, 1}, []int64{8, 2}},
		{"larger minutes wins the cent regardless of order", 10, []int64{1, 3}, []int64{2, 8}},
		{"negative minutes clamp to zero", 100, []int64{-30, 30}, []int64{0, 100}},
		{"negative amount yields no payout", -100, []int64{30, 30}, []int64{0, 0}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := SplitByMinutes(tc.amount, tc.minutes)
			if !slices.Equal(got, tc.want) {
				t.Fatalf("SplitByMinutes(%d, %v) = %v, want %v", tc.amount, tc.minutes, got, tc.want)
			}
		})
	}
}

// The exactness guarantee is the whole point of largest remainder, so it is
// checked over a wide spread of pools and shift lengths rather than a handful
// of hand-picked ones. Seeded: a failure here reproduces verbatim.
func TestSplitByMinutesInvariants(t *testing.T) {
	t.Parallel()
	rng := rand.New(rand.NewPCG(1, 2))

	for c := range 500 {
		minutes := make([]int64, rng.IntN(12))
		for i := range minutes {
			minutes[i] = int64(rng.IntN(1441)) // a day's worth, zeros included
		}
		amount := int64(rng.IntN(1_000_001))

		shares := SplitByMinutes(amount, minutes)
		if len(shares) != len(minutes) {
			t.Fatalf("case %d: got %d shares for %d members", c, len(shares), len(minutes))
		}

		var sum, worked int64
		for i, s := range shares {
			if s < 0 {
				t.Fatalf("case %d: negative share %d for minutes %v", c, s, minutes)
			}
			sum += s
			worked += minutes[i]
		}
		want := amount
		if worked == 0 {
			want = 0
		}
		if sum != want {
			t.Fatalf("case %d: shares %v sum to %d, want %d (minutes %v)", c, shares, sum, want, minutes)
		}

		// Monotonicity holds exactly, it is not an approximation: more minutes
		// never earns strictly fewer cents. amount*m_i/total >= amount*m_j/total
		// when m_i > m_j, and equal floors would force
		// amount*(m_i-m_j) == remainder_i-remainder_j, so the longer shift can
		// never have the smaller remainder and lose the leftover cent.
		for i := range shares {
			for j := range shares {
				if minutes[i] > minutes[j] && shares[i] < shares[j] {
					t.Fatalf("case %d: %d min earned %d but %d min earned %d (minutes %v)",
						c, minutes[i], shares[i], minutes[j], shares[j], minutes)
				}
			}
		}
	}
}

func TestSplitByMinutesIsDeterministic(t *testing.T) {
	t.Parallel()
	minutes := []int64{480, 300, 300, 1, 0, 77}
	first := SplitByMinutes(9_999, minutes)
	for range 10 {
		if got := SplitByMinutes(9_999, minutes); !slices.Equal(got, first) {
			t.Fatalf("got %v, want %v", got, first)
		}
	}
}
