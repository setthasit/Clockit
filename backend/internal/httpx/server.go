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
