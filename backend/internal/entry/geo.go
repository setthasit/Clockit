package entry

import (
	"math"
	"time"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

const earthRadiusM = 6371000

// Fix is one device location reading submitted with a clock event or ping.
type Fix struct {
	Lat, Lng, AccuracyM float64
	At                  time.Time
	Mocked              bool
}

func haversineM(lat1, lng1, lat2, lng2 float64) float64 {
	rad := math.Pi / 180
	dLat, dLng := (lat2-lat1)*rad/2, (lng2-lng1)*rad/2
	a := math.Sin(dLat)*math.Sin(dLat) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLng)*math.Sin(dLng)
	return 2 * earthRadiusM * math.Asin(math.Min(1, math.Sqrt(a)))
}

// ValidateFix applies the design §4.5 location rules and returns the first
// violation, or nil. anchor == nil skips the distance rule (personal entries).
func ValidateFix(cfg config.Config, now time.Time, f Fix, anchor *employer.LatLng) *httpx.AppError {
	// ponytail: JSON binding already rejects NaN/Inf, but every comparison below
	// is false for NaN — a non-HTTP caller could otherwise pass a garbage fix.
	if !finite(f.Lat, f.Lng, f.AccuracyM) || (anchor != nil && !finite(anchor.Lat, anchor.Lng)) {
		return httpx.Invalid("malformed coordinates")
	}
	if f.Mocked {
		return httpx.MockedLocation()
	}
	if f.AccuracyM > float64(cfg.MaxAccuracyM) {
		return httpx.LowAccuracy()
	}
	if skew := now.Sub(f.At); skew > cfg.MaxClockSkew || skew < -cfg.MaxClockSkew {
		return httpx.StaleTimestamp()
	}
	if anchor != nil && !WithinAnchor(cfg, employer.LatLng{Lat: f.Lat, Lng: f.Lng}, *anchor) {
		return httpx.OutOfRange(haversineM(f.Lat, f.Lng, anchor.Lat, anchor.Lng), float64(cfg.AnchorRadiusM))
	}
	return nil
}

// SpeedAnomaly reports an impossible ground speed between two consecutive
// fixes. Pings are never rejected for where they are — people move (design
// §4.5) — so this only decides whether the entry gets flagged.
//
// A non-positive interval is unmeasurable rather than suspicious: the outbox
// can flush duplicate or same-millisecond fixes, and those are not evidence.
func SpeedAnomaly(cfg config.Config, prev, curr Fix) bool {
	hours := curr.At.Sub(prev.At).Hours()
	if hours <= 0 || !finite(prev.Lat, prev.Lng, curr.Lat, curr.Lng) {
		return false
	}
	kmh := haversineM(prev.Lat, prev.Lng, curr.Lat, curr.Lng) / 1000 / hours
	return kmh > float64(cfg.SpeedAnomalyKMH)
}

// WithinAnchor is the distance rule on its own, for assign-employer: it
// re-measures a stored fix that was already judged for mock, accuracy and skew
// at capture time, so only position is still in question.
//
// Compared at whole-metre resolution, the same unit the client is told about: a
// fix on the radius must never be refused with "1000 m from anchor (limit
// 1000 m)", and sub-metre float noise is not a violation.
func WithinAnchor(cfg config.Config, loc, anchor employer.LatLng) bool {
	if !finite(loc.Lat, loc.Lng, anchor.Lat, anchor.Lng) {
		return false
	}
	return math.Round(haversineM(loc.Lat, loc.Lng, anchor.Lat, anchor.Lng)) <= float64(cfg.AnchorRadiusM)
}

func finite(vs ...float64) bool {
	for _, v := range vs {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return true
}
