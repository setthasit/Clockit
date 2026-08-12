package httpx_test

import (
	"encoding/json"
	"testing"

	"github.com/setthasit/clockit/backend/internal/httpx"
)

// The detail keys are a wire contract both frontends read.
func TestOutOfRangeDetails(t *testing.T) {
	t.Parallel()

	body, err := json.Marshal(httpx.OutOfRange(1799.6, 150))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"code":"OUT_OF_RANGE","message":"1800 m from anchor (limit 150 m)","details":{"distance_m":1800,"limit_m":150}}`
	if string(body) != want {
		t.Errorf("got  %s\nwant %s", body, want)
	}
}
