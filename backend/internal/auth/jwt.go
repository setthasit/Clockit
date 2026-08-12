package auth

import (
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

type Identity struct {
	Sub           string
	Email         string
	EmailVerified bool
}

const identityKey = "clockit.identity"

// claims reads the namespaced custom claims the Auth0 Action sets (design §3).
type claims struct {
	jwt.RegisteredClaims
	Email         string `json:"https://clockit/email"`
	EmailVerified bool   `json:"https://clockit/email_verified"`
}

func NewMiddleware(cfg config.Config) (echo.MiddlewareFunc, error) {
	kf, err := keyfunc.NewDefault([]string{"https://" + cfg.Auth0Domain + "/.well-known/jwks.json"})
	if err != nil {
		return nil, err
	}
	return NewMiddlewareWithKeyfunc(cfg, kf.Keyfunc), nil
}

func NewMiddlewareWithKeyfunc(cfg config.Config, kf jwt.Keyfunc) echo.MiddlewareFunc {
	opts := []jwt.ParserOption{
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithAudience(cfg.Auth0Audience),
		jwt.WithIssuer("https://" + cfg.Auth0Domain + "/"),
		jwt.WithExpirationRequired(),
	}
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			raw, ok := strings.CutPrefix(c.Request().Header.Get("Authorization"), "Bearer ")
			if !ok || raw == "" {
				return httpx.Unauthenticated()
			}
			var cl claims
			token, err := jwt.ParseWithClaims(raw, &cl, kf, opts...)
			if err != nil || !token.Valid {
				return httpx.Unauthenticated()
			}
			id := Identity{Sub: cl.Subject, Email: cl.Email, EmailVerified: cl.EmailVerified}
			c.Set(identityKey, id)
			trace.SpanFromContext(c.Request().Context()).
				SetAttributes(attribute.String("user.sub", id.Sub))
			return next(c)
		}
	}
}

// FromContext panics if the middleware is missing — programmer error, not a runtime condition.
func FromContext(c echo.Context) Identity {
	return c.Get(identityKey).(Identity)
}
