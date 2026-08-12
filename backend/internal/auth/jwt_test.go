package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

const (
	testDomain   = "test.auth0.local"
	testAudience = "https://api.clockit.duckos.ai"
)

func testConfig() config.Config {
	return config.Config{Auth0Domain: testDomain, Auth0Audience: testAudience}
}

func baseClaims() jwt.MapClaims {
	return jwt.MapClaims{
		"sub":                            "auth0|user1",
		"iss":                            "https://" + testDomain + "/",
		"aud":                            testAudience,
		"exp":                            time.Now().Add(time.Hour).Unix(),
		"iat":                            time.Now().Unix(),
		"https://clockit/email":          "user1@example.com",
		"https://clockit/email_verified": true,
	}
}

func newHandler(t *testing.T, key *rsa.PrivateKey) http.Handler {
	t.Helper()
	e := echo.New()
	e.HTTPErrorHandler = httpx.ErrorHandler
	mw := NewMiddlewareWithKeyfunc(testConfig(), func(*jwt.Token) (any, error) {
		return &key.PublicKey, nil
	})
	e.GET("/protected", func(c echo.Context) error {
		return c.JSON(http.StatusOK, FromContext(c))
	}, mw)
	return e
}

func TestMiddleware(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler(t, key)

	sign := func(t *testing.T, method jwt.SigningMethod, signKey any, mutate func(jwt.MapClaims)) string {
		t.Helper()
		cl := baseClaims()
		if mutate != nil {
			mutate(cl)
		}
		raw, err := jwt.NewWithClaims(method, cl).SignedString(signKey)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}

	tests := []struct {
		name       string
		token      string
		wantStatus int
	}{
		{"valid", sign(t, jwt.SigningMethodRS256, key, nil), http.StatusOK},
		{"expired", sign(t, jwt.SigningMethodRS256, key, func(cl jwt.MapClaims) {
			cl["exp"] = time.Now().Add(-time.Hour).Unix()
		}), http.StatusUnauthorized},
		{"missing exp", sign(t, jwt.SigningMethodRS256, key, func(cl jwt.MapClaims) {
			delete(cl, "exp")
		}), http.StatusUnauthorized},
		{"wrong audience", sign(t, jwt.SigningMethodRS256, key, func(cl jwt.MapClaims) {
			cl["aud"] = "https://other.example.com"
		}), http.StatusUnauthorized},
		{"wrong issuer", sign(t, jwt.SigningMethodRS256, key, func(cl jwt.MapClaims) {
			cl["iss"] = "https://evil.example.com/"
		}), http.StatusUnauthorized},
		{"alg none", sign(t, jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, nil), http.StatusUnauthorized},
		{"HS256 signed", sign(t, jwt.SigningMethodHS256, []byte("secret"), nil), http.StatusUnauthorized},
		{"no token", "", http.StatusUnauthorized},
		{"garbage", "not.a.jwt", http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/protected", nil)
			if tt.token != "" {
				req.Header.Set("Authorization", "Bearer "+tt.token)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tt.wantStatus {
				t.Fatalf("status: got %d want %d, body %s", rec.Code, tt.wantStatus, rec.Body)
			}
			if tt.wantStatus == http.StatusOK {
				body := rec.Body.String()
				for _, want := range []string{"auth0|user1", "user1@example.com"} {
					if !strings.Contains(body, want) {
						t.Fatalf("identity missing %q in %s", want, body)
					}
				}
			} else if !strings.Contains(rec.Body.String(), "UNAUTHENTICATED") {
				t.Fatalf("want UNAUTHENTICATED error body, got %s", rec.Body)
			}
		})
	}
}
