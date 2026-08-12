package main

import (
	"go.uber.org/fx"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/httpx"
	"github.com/setthasit/clockit/backend/internal/mongox"
	"github.com/setthasit/clockit/backend/internal/otelx"
	"github.com/setthasit/clockit/backend/internal/user"
	"github.com/setthasit/clockit/backend/internal/valkeyx"
)

func main() {
	fx.New(
		fx.Provide(config.Load, httpx.NewEcho, mongox.New, valkeyx.New, crypto.NewEnvelope, auth.NewMiddleware,
			user.NewStore, user.NewHandler),
		fx.Invoke(otelx.Setup, mongox.RegisterIndexes, user.RegisterRoutes, httpx.Start),
	).Run()
}
