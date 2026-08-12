package valkeyx

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

func testClient(t *testing.T) valkey.Client {
	t.Helper()
	addr := os.Getenv("VALKEY_ADDR")
	if addr == "" {
		t.Skip("VALKEY_ADDR not set")
	}
	client, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{addr}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return client
}

// newServer wires the middleware behind a stub that seeds the identity the way
// the auth middleware does in production.
func newServer(client valkey.Client, limit int, sub string) http.Handler {
	e := echo.New()
	e.HTTPErrorHandler = httpx.ErrorHandler
	seedIdentity := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Set("clockit.identity", auth.Identity{Sub: sub})
			return next(c)
		}
	}
	handler := func(c echo.Context) error { return c.NoContent(http.StatusOK) }
	mw := RateLimit(client, config.Config{RateLimitPerMin: limit})
	e.POST("/v1/entries/clock-in", handler, seedIdentity, mw)
	e.POST("/v1/entries/clock-out", handler, seedIdentity, mw)
	return e
}

func post(t *testing.T, handler http.Handler, path string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
	return rec.Code
}

func TestRateLimit(t *testing.T) {
	client := testClient(t)
	// Unique sub per run keeps the fixed-window keys from leaking across runs.
	sub := fmt.Sprintf("auth0|test-%d", time.Now().UnixNano())
	handler := newServer(client, 2, sub)

	for i, want := range []int{http.StatusOK, http.StatusOK, http.StatusTooManyRequests} {
		if got := post(t, handler, "/v1/entries/clock-in"); got != want {
			t.Fatalf("request %d: got %d want %d", i+1, got, want)
		}
	}

	// A different route is a different bucket.
	if got := post(t, handler, "/v1/entries/clock-out"); got != http.StatusOK {
		t.Fatalf("other route: got %d want %d", got, http.StatusOK)
	}
	// A different user is a different bucket.
	if got := post(t, newServer(client, 2, sub+"-other"), "/v1/entries/clock-in"); got != http.StatusOK {
		t.Fatalf("other user: got %d want %d", got, http.StatusOK)
	}
}

func TestRateLimitFailsOpenWhenValkeyUnavailable(t *testing.T) {
	client := testClient(t)
	client.Close()

	handler := newServer(client, 0, "auth0|unavailable")
	if got := post(t, handler, "/v1/entries/clock-in"); got != http.StatusOK {
		t.Fatalf("got %d want %d", got, http.StatusOK)
	}
}
