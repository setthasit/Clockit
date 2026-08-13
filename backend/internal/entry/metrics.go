package entry

import (
	"context"
	"errors"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

// Domain telemetry for the clock endpoints (design §4.8). Only derived scalars
// are ever emitted: a distance is a number, a coordinate is not.
var (
	clockInTotal = counter("clockit.clock_in.total",
		"Fresh clock-in attempts by result; a replay is not a new shift, it counts as an outbox sync")
	proximityRejectedTotal = counter("clockit.proximity.rejected.total",
		"Clock events refused by a location rule, by reason")
	outboxSyncTotal = counter("clockit.outbox.sync.total",
		"Successful clock mutations by whether the client_id was fresh or a replay")
)

// counter panics rather than returning an error: the names are constants, so a
// failure here is a build-time bug the package test catches, not a runtime
// condition worth threading through every handler constructor.
func counter(name, description string) metric.Int64Counter {
	c, err := otel.Meter("clockit/entry").Int64Counter(name, metric.WithDescription(description))
	if err != nil {
		panic(err)
	}
	return c
}

// proximityReasons bounds the {reason} label to the location verdicts. A metric
// label must never carry an open set of strings.
var proximityReasons = map[string]bool{
	"MOCKED_LOCATION": true,
	"LOW_ACCURACY":    true,
	"STALE_TIMESTAMP": true,
	"OUT_OF_RANGE":    true,
}

// clockObs is what a clock handler learns on its way through. The handler fills
// it in as the facts arrive and reports once on the way out, so every exit —
// replay, rejection, success — is instrumented from one place.
type clockObs struct {
	fix    *Fix
	anchor *employer.LatLng
	replay bool
}

func (o *clockObs) report(ctx context.Context, err error) {
	attrs := []attribute.KeyValue{attribute.String("clockit.verdict", verdictOf(o.replay, err))}
	if o.fix != nil {
		attrs = append(attrs, attribute.Float64("clockit.accuracy_m", o.fix.AccuracyM))
		if o.anchor != nil {
			attrs = append(attrs, attribute.Float64("clockit.distance_m",
				haversineM(o.fix.Lat, o.fix.Lng, o.anchor.Lat, o.anchor.Lng)))
		}
	}
	// otelecho already opened the server span; the verdict belongs on it rather
	// than on a child span nobody would look at.
	trace.SpanFromContext(ctx).SetAttributes(attrs...)

	var appErr *httpx.AppError
	if errors.As(err, &appErr) && proximityReasons[appErr.Code] {
		proximityRejectedTotal.Add(ctx, 1,
			metric.WithAttributes(attribute.String("reason", strings.ToLower(appErr.Code))))
	}
	if err == nil {
		outboxSyncTotal.Add(ctx, 1, metric.WithAttributes(attribute.String("result", syncResult(o.replay))))
	}
}

func (o *clockObs) reportClockIn(ctx context.Context, err error) {
	o.report(ctx, err)
	// A replay is one shift arriving twice; counting it here would inflate the
	// shift count this metric exists to measure. It is an outbox sync instead.
	if !o.replay {
		clockInTotal.Add(ctx, 1, metric.WithAttributes(attribute.String("result", clockInResult(err))))
	}
}

// verdictOf names the outcome for the span: the error code a client would key
// off, or how the request succeeded.
func verdictOf(replay bool, err error) string {
	var appErr *httpx.AppError
	switch {
	case errors.As(err, &appErr):
		return strings.ToLower(appErr.Code)
	case err != nil:
		return "error"
	case replay:
		return "replay"
	default:
		return "ok"
	}
}

func clockInResult(err error) string {
	if err != nil {
		return "rejected"
	}
	return "ok"
}

func syncResult(replay bool) string {
	if replay {
		return "replay"
	}
	return "ok"
}
