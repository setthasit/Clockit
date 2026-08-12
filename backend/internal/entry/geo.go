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
	if anchor != nil {
		// Compared at whole-metre resolution, the same unit the client is told
		// about: a fix on the radius must never be refused with "1000 m from
		// anchor (limit 1000 m)", and sub-metre float noise is not a violation.
		if d := haversineM(f.Lat, f.Lng, anchor.Lat, anchor.Lng); math.Round(d) > float64(cfg.AnchorRadiusM) {
			return httpx.OutOfRange(d, float64(cfg.AnchorRadiusM))
		}
	}
	return nil
}

func finite(vs ...float64) bool {
	for _, v := range vs {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return true
}
