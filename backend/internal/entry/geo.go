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
//
// Queued marks a reading the client captured offline and replayed later. It is
// a client assertion, so it buys exactly one thing: the freshness rule is
// widened to cfg.MaxQueuedAge. Every other rule still applies.
type Fix struct {
	Lat, Lng, AccuracyM float64
	At                  time.Time
	Mocked              bool
	Queued              bool
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
	// The past bound is the only half a queued event may widen: an outbox item
	// is old by construction (design §5.3), but nothing legitimate captures a
	// fix in the future, and a clock running fast is still a broken clock.
	maxAge := cfg.MaxClockSkew
	if f.Queued {
		maxAge = cfg.MaxQueuedAge
	}
	switch age := now.Sub(f.At); {
	case age < -cfg.MaxClockSkew:
		return httpx.StaleTimestamp()
	case age > maxAge:
		if f.Queued {
			return httpx.QueuedTooOld()
		}
		return httpx.StaleTimestamp()
	}
	if anchor != nil && !WithinAnchor(cfg, employer.LatLng{Lat: f.Lat, Lng: f.Lng}, *anchor) {
		return httpx.OutOfRange(haversineM(f.Lat, f.Lng, anchor.Lat, anchor.Lng), float64(cfg.AnchorRadiusM))
	}
	return nil
}

// ValidateClose is ValidateFix for the event that ends a shift: every rule
// still applies except the backdating ceiling.
//
// A close asserts no hours the clock-in did not already put on record, and that
// clock-in passed the ceiling when it was accepted. Refusing a late close cannot
// take those hours back — it can only strand the shift open, and an open shift
// blocks every later clock-in with no other way to close it (design §4.5).
func ValidateClose(cfg config.Config, now time.Time, f Fix, anchor *employer.LatLng) *httpx.AppError {
	// config.Config is a value, so this widens the ceiling for this call alone.
	cfg.MaxQueuedAge = math.MaxInt64
	return ValidateFix(cfg, now, f, anchor)
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
