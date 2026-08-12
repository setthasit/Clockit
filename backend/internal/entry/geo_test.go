package entry

import (
	"math"
	"testing"
	"time"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/employer"
)

// Downtown Vancouver; offsets below are derived from the same sphere the
// implementation uses, so "1000 m" means exactly 1000 m — not a rounded
// figure copied from a map tool.
const (
	vanLat = 49.2827
	vanLng = -123.1207
)

// degrees of latitude / longitude spanning m metres on a sphere of R=6371000.
func northOffset(m float64) float64 { return m / earthRadiusM * 180 / math.Pi }
func eastOffset(m, atLat float64) float64 {
	return northOffset(m) / math.Cos(atLat*math.Pi/180)
}

func geoCfg() config.Config {
	return config.Config{MaxAccuracyM: 100, MaxClockSkew: 5 * time.Minute, AnchorRadiusM: 1000}
}

func TestHaversineKnownDistances(t *testing.T) {
	cases := []struct {
		name                   string
		lat1, lng1, lat2, lng2 float64
		want                   float64
	}{
		{"identical point", vanLat, vanLng, vanLat, vanLng, 0},
		{"1 km north", vanLat, vanLng, vanLat + northOffset(1000), vanLng, 1000},
		{"1 km south", vanLat, vanLng, vanLat - northOffset(1000), vanLng, 1000},
		{"1 km east", vanLat, vanLng, vanLat, vanLng + eastOffset(1000, vanLat), 1000},
		{"1 km west", vanLat, vanLng, vanLat, vanLng - eastOffset(1000, vanLat), 1000},
		{"250 m north", vanLat, vanLng, vanLat + northOffset(250), vanLng, 250},
		// Vancouver -> Seattle city centres, ~190 km great-circle.
		{"Vancouver to Seattle", vanLat, vanLng, 47.6062, -122.3321, 195_000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := haversineM(tc.lat1, tc.lng1, tc.lat2, tc.lng2)
			tol := 1.0
			if tc.want > 10_000 { // long haul: the east-west leg is only ~0.5% off
				tol = tc.want * 0.01
			}
			if math.Abs(got-tc.want) > tol {
				t.Fatalf("haversineM = %.3f m, want %.3f m (±%.0f)", got, tc.want, tol)
			}
		})
	}
}

func TestHaversineIsSymmetric(t *testing.T) {
	a := haversineM(vanLat, vanLng, 47.6062, -122.3321)
	b := haversineM(47.6062, -122.3321, vanLat, vanLng)
	if a != b {
		t.Fatalf("asymmetric: %v vs %v", a, b)
	}
}

func TestValidateFixAccepts(t *testing.T) {
	now := time.Now().UTC()
	anchor := &employer.LatLng{Lat: vanLat, Lng: vanLng}

	cases := []struct {
		name   string
		fix    Fix
		anchor *employer.LatLng
	}{
		{"at the anchor", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: now}, anchor},
		{"exactly at the radius", Fix{Lat: vanLat + northOffset(1000), Lng: vanLng, AccuracyM: 10, At: now}, anchor},
		{"accuracy exactly at the limit", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 100, At: now}, anchor},
		{"skew exactly at the limit", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: now.Add(-5 * time.Minute)}, anchor},
		{"future skew at the limit", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: now.Add(5 * time.Minute)}, anchor},
		{"rounds down to the radius", Fix{Lat: vanLat + northOffset(1000.4), Lng: vanLng, AccuracyM: 10, At: now}, anchor},
		{"no anchor skips distance", Fix{Lat: 13.7563, Lng: 100.5018, AccuracyM: 10, At: now}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateFix(geoCfg(), now, tc.fix, tc.anchor); err != nil {
				t.Fatalf("ValidateFix = %s (%s), want nil", err.Code, err.Message)
			}
		})
	}
}

func TestValidateFixRejections(t *testing.T) {
	now := time.Now().UTC()
	anchor := &employer.LatLng{Lat: vanLat, Lng: vanLng}
	far := Fix{Lat: vanLat + northOffset(1800), Lng: vanLng, AccuracyM: 10, At: now}

	cases := []struct {
		name   string
		fix    Fix
		anchor *employer.LatLng
		want   string
	}{
		{"mocked", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: now, Mocked: true}, anchor, "MOCKED_LOCATION"},
		{"mocked without anchor", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: now, Mocked: true}, nil, "MOCKED_LOCATION"},
		{"accuracy over the limit", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 100.1, At: now}, anchor, "LOW_ACCURACY"},
		{"stale past fix", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: now.Add(-5*time.Minute - time.Second)}, anchor, "STALE_TIMESTAMP"},
		{"stale future fix", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: now.Add(5*time.Minute + time.Second)}, anchor, "STALE_TIMESTAMP"},
		{"rounds up past the radius", Fix{Lat: vanLat + northOffset(1000.6), Lng: vanLng, AccuracyM: 10, At: now}, anchor, "OUT_OF_RANGE"},
		{"one metre past the radius", Fix{Lat: vanLat + northOffset(1001), Lng: vanLng, AccuracyM: 10, At: now}, anchor, "OUT_OF_RANGE"},
		{"far from the anchor", far, anchor, "OUT_OF_RANGE"},

		// Precedence: the cheapest, most actionable reason wins.
		{"mocked beats everything", Fix{Lat: far.Lat, Lng: far.Lng, AccuracyM: 500, At: now.Add(-time.Hour), Mocked: true}, anchor, "MOCKED_LOCATION"},
		{"accuracy beats stale and range", Fix{Lat: far.Lat, Lng: far.Lng, AccuracyM: 500, At: now.Add(-time.Hour)}, anchor, "LOW_ACCURACY"},
		{"stale beats range", Fix{Lat: far.Lat, Lng: far.Lng, AccuracyM: 10, At: now.Add(-time.Hour)}, anchor, "STALE_TIMESTAMP"},

		{"NaN coordinate", Fix{Lat: math.NaN(), Lng: vanLng, AccuracyM: 10, At: now}, anchor, "INVALID_ARGUMENT"},
		{"NaN accuracy", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: math.NaN(), At: now}, anchor, "INVALID_ARGUMENT"},
		{"infinite longitude", Fix{Lat: vanLat, Lng: math.Inf(1), AccuracyM: 10, At: now}, anchor, "INVALID_ARGUMENT"},
		{"NaN anchor", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: now}, &employer.LatLng{Lat: math.NaN()}, "INVALID_ARGUMENT"},
		{"malformed beats mocked", Fix{Lat: math.NaN(), Lng: vanLng, AccuracyM: 10, At: now, Mocked: true}, anchor, "INVALID_ARGUMENT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateFix(geoCfg(), now, tc.fix, tc.anchor)
			if err == nil {
				t.Fatalf("ValidateFix = nil, want %s", tc.want)
			}
			if err.Code != tc.want {
				t.Fatalf("ValidateFix = %s, want %s", err.Code, tc.want)
			}
		})
	}
}

func TestOutOfRangeCarriesDistanceDetails(t *testing.T) {
	now := time.Now().UTC()
	anchor := &employer.LatLng{Lat: vanLat, Lng: vanLng}
	fix := Fix{Lat: vanLat + northOffset(1800), Lng: vanLng, AccuracyM: 10, At: now}

	err := ValidateFix(geoCfg(), now, fix, anchor)
	if err == nil || err.Code != "OUT_OF_RANGE" {
		t.Fatalf("ValidateFix = %v, want OUT_OF_RANGE", err)
	}
	if got := err.Details["distance_m"]; got != 1800 {
		t.Fatalf("distance_m = %v, want 1800", got)
	}
	if got := err.Details["limit_m"]; got != 1000 {
		t.Fatalf("limit_m = %v, want 1000", got)
	}
}
