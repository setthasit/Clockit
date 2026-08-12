package valkeyx

import (
	"log/slog"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

const windowSeconds = 60

// RateLimit caps mutations per user per minute.
//
// ponytail: fixed window; switch to a sliding window if bursts straddling the
// minute boundary ever matter.
//
// Valkey being down must not take clock-in down with it, so any Valkey error
// logs and lets the request through — availability over rate limiting for v1.
// Requires the auth middleware to have run first.
func RateLimit(client valkey.Client, cfg config.Config) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			ctx := c.Request().Context()
			// c.Path() is the registered route pattern, so path params cannot
			// explode key cardinality.
			key := "rl:" + auth.FromContext(c).Sub + ":" + c.Path() + ":" +
				strconv.FormatInt(time.Now().Unix()/windowSeconds, 10)

			// Re-EXPIRE on every hit is harmless: the key names its own window,
			// so refreshing the TTL cannot extend that window.
			resps := client.DoMulti(ctx,
				client.B().Incr().Key(key).Build(),
				client.B().Expire().Key(key).Seconds(windowSeconds).Build(),
			)
			count, err := resps[0].AsInt64()
			if err != nil {
				slog.WarnContext(ctx, "rate limit unavailable, allowing request", "error", err)
				return next(c)
			}
			if count > int64(cfg.RateLimitPerMin) {
				return httpx.RateLimited()
			}
			return next(c)
		}
	}
}
