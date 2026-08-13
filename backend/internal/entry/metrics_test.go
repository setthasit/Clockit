package entry

import (
	"context"
	"math"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

func testObs() *clockObs {
	fix := Fix{Lat: vanLat + northOffset(1500), Lng: vanLng, AccuracyM: 12}
	anchor := employer.LatLng{Lat: vanLat, Lng: vanLng}
	return &clockObs{fix: &fix, anchor: &anchor}
}

// The rejection verdict and the distance that produced it are the two things
// worth having on a trace when someone asks why a clock-in was refused.
func TestClockObsSpanAttributes(t *testing.T) {
	cases := []struct {
		name    string
		obs     *clockObs
		err     error
		verdict string
	}{
		{"rejection", testObs(), httpx.OutOfRange(1500, 1000), "out_of_range"},
		{"success", testObs(), nil, "ok"},
		{"replay", &clockObs{replay: true}, nil, "replay"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := tracetest.NewSpanRecorder()
			tracer := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder)).Tracer("test")
			ctx, span := tracer.Start(context.Background(), "clock")
			tc.obs.report(ctx, tc.err)
			span.End()

			attrs := map[attribute.Key]attribute.Value{}
			for _, kv := range recorder.Ended()[0].Attributes() {
				attrs[kv.Key] = kv.Value
			}
			if got := attrs["clockit.verdict"].AsString(); got != tc.verdict {
				t.Fatalf("clockit.verdict = %q, want %q", got, tc.verdict)
			}
			if tc.obs.fix == nil {
				return
			}
			if got := attrs["clockit.accuracy_m"].AsFloat64(); got != 12 {
				t.Fatalf("clockit.accuracy_m = %v, want 12", got)
			}
			if got := attrs["clockit.distance_m"].AsFloat64(); math.Abs(got-1500) > 1 {
				t.Fatalf("clockit.distance_m = %v, want 1500 ±1", got)
			}
		})
	}
}

// Counters carry bounded labels only, and a replay is deliberately absent from
// clock_in.total: it is the same shift arriving twice, not a second one.
func TestClockObsCounters(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	otel.SetMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)))
	ctx := context.Background()

	before := collect(t, reader)
	testObs().reportClockIn(ctx, httpx.OutOfRange(1500, 1000))
	testObs().reportClockIn(ctx, nil)
	(&clockObs{replay: true}).reportClockIn(ctx, nil)
	(&clockObs{}).report(ctx, httpx.NoOpenEntry())
	after := collect(t, reader)

	want := map[string]map[string]int64{
		"clockit.clock_in.total":           {"result=ok": 1, "result=rejected": 1},
		"clockit.proximity.rejected.total": {"reason=out_of_range": 1},
		"clockit.outbox.sync.total":        {"result=ok": 1, "result=replay": 1},
	}
	for name, points := range want {
		for label, delta := range points {
			if got := after[name][label] - before[name][label]; got != delta {
				t.Errorf("%s{%s} rose by %d, want %d", name, label, got, delta)
			}
		}
	}
	// NO_OPEN_ENTRY is a conflict, not a location verdict: it must not reach the
	// proximity counter, whose label set is what keeps its cardinality bounded.
	if len(after["clockit.proximity.rejected.total"]) != len(before["clockit.proximity.rejected.total"])+1 {
		t.Errorf("proximity reasons = %v, want only out_of_range added", after["clockit.proximity.rejected.total"])
	}
}

// collect flattens the reader's counters into name → "key=value" → sum. Tests
// compare deltas: other tests in this package share the global meter provider.
func collect(t *testing.T, reader *sdkmetric.ManualReader) map[string]map[string]int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[string]map[string]int64{}
	for _, scope := range rm.ScopeMetrics {
		for _, m := range scope.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				continue
			}
			points := map[string]int64{}
			for _, dp := range sum.DataPoints {
				for _, kv := range dp.Attributes.ToSlice() {
					points[string(kv.Key)+"="+kv.Value.AsString()] += dp.Value
				}
			}
			out[m.Name] = points
		}
	}
	return out
}
