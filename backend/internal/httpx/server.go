package httpx

import (
	"context"
	"errors"
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
	"go.uber.org/fx"

	"github.com/setthasit/clockit/backend/internal/config"
)

func NewEcho(cfg config.Config) *echo.Echo {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true
	e.Use(middleware.Recover())
	e.Use(middleware.BodyLimit("1M"))
	e.Use(otelecho.Middleware("clockit-api")) // traces + http metrics
	// Registered only when origins are configured: Echo's CORS defaults AllowOrigins
	// to "*" on an empty list, so an unset env var would publish a wildcard API
	// rather than the same-origin dev setup that needs no CORS at all.
	if len(cfg.CORSOrigins) > 0 {
		e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
			AllowOrigins: cfg.CORSOrigins,
			AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete},
			// What web/src/lib/api.ts actually sends. Authorization is what forces a
			// preflight on every call, hence MaxAge below.
			AllowHeaders: []string{echo.HeaderAuthorization, echo.HeaderContentType},
			// Bearer tokens, not cookies: credentials must stay off so a reflected
			// origin can never carry an ambient session.
			AllowCredentials: false,
			MaxAge:           3600,
		}))
	}
	e.HTTPErrorHandler = ErrorHandler
	e.GET("/healthz", func(c echo.Context) error { return c.NoContent(http.StatusOK) })
	return e
}

func Start(lc fx.Lifecycle, e *echo.Echo, cfg config.Config) {
	lc.Append(fx.Hook{
		OnStart: func(ctx context.Context) error {
			go func() {
				if err := e.Start(cfg.HTTPAddr); err != nil && !errors.Is(err, http.ErrServerClosed) {
					e.Logger.Fatal(err)
				}
			}()
			return nil
		},
		OnStop: func(ctx context.Context) error {
			return e.Shutdown(ctx)
		},
	})
}
