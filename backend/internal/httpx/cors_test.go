package httpx_test

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

const webOrigin = "https://clockit.example.dev"

// Routes carry auth as per-route middleware, so the preflight — which browsers send
// with no Authorization header — must be answered before that middleware runs.
// Anything that reaches the handler here is a regression that blocks every browser call.
func newCORSServer(t *testing.T, origins []string) http.Handler {
	t.Helper()
	e := httpx.NewEcho(config.Config{CORSOrigins: origins})
	rejectAuth := func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			return echo.NewHTTPError(http.StatusUnauthorized)
		}
	}
	e.PATCH("/v1/me", func(c echo.Context) error { return c.NoContent(http.StatusOK) }, rejectAuth)
	return e
}

func TestCORSPreflightSkipsAuth(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodOptions, "/v1/me", nil)
	req.Header.Set(echo.HeaderOrigin, webOrigin)
	req.Header.Set(echo.HeaderAccessControlRequestMethod, http.MethodPatch)
	req.Header.Set(echo.HeaderAccessControlRequestHeaders, echo.HeaderAuthorization)
	res := httptest.NewRecorder()

	newCORSServer(t, []string{webOrigin}).ServeHTTP(res, req)

	if res.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204 (auth must not see the preflight)", res.Code)
	}
	if got := res.Header().Get(echo.HeaderAccessControlAllowOrigin); got != webOrigin {
		t.Errorf("allow-origin = %q, want %q", got, webOrigin)
	}
	for _, want := range []string{echo.HeaderAuthorization, echo.HeaderContentType} {
		if got := res.Header().Get(echo.HeaderAccessControlAllowHeaders); !contains(got, want) {
			t.Errorf("allow-headers = %q, missing %q", got, want)
		}
	}
	if got := res.Header().Get(echo.HeaderAccessControlAllowMethods); !contains(got, http.MethodPatch) {
		t.Errorf("allow-methods = %q, missing PATCH", got)
	}
	// Bearer tokens, not cookies: credentials on would let a reflected origin ride an
	// ambient session.
	if got := res.Header().Get(echo.HeaderAccessControlAllowCredentials); got != "" {
		t.Errorf("allow-credentials = %q, want unset", got)
	}
}

func TestCORSRejectsUnlistedOrigin(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodOptions, "/v1/me", nil)
	req.Header.Set(echo.HeaderOrigin, "https://attacker.example")
	req.Header.Set(echo.HeaderAccessControlRequestMethod, http.MethodPatch)
	res := httptest.NewRecorder()

	newCORSServer(t, []string{webOrigin}).ServeHTTP(res, req)

	if got := res.Header().Get(echo.HeaderAccessControlAllowOrigin); got != "" {
		t.Errorf("allow-origin = %q, want unset for an unlisted origin", got)
	}
}

// An unset CORS_ORIGINS must not fall through to Echo's "*" default.
func TestCORSDisabledWithoutOrigins(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set(echo.HeaderOrigin, webOrigin)
	res := httptest.NewRecorder()

	newCORSServer(t, nil).ServeHTTP(res, req)

	if got := res.Header().Get(echo.HeaderAccessControlAllowOrigin); got != "" {
		t.Errorf("allow-origin = %q, want unset when no origins are configured", got)
	}
}

func contains(headerList, want string) bool {
	return slices.ContainsFunc(strings.Split(headerList, ","), func(v string) bool {
		return strings.EqualFold(strings.TrimSpace(v), want)
	})
}
