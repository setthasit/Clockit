package valkeyx

import (
	"context"

	"github.com/valkey-io/valkey-go"
	"github.com/valkey-io/valkey-go/valkeyotel"
	"go.uber.org/fx"

	"github.com/setthasit/clockit/backend/internal/config"
)

func New(lc fx.Lifecycle, cfg config.Config) (valkey.Client, error) {
	client, err := valkeyotel.NewClient(valkey.ClientOption{InitAddress: []string{cfg.ValkeyAddr}})
	if err != nil {
		return nil, err
	}
	lc.Append(fx.Hook{
		OnStop: func(context.Context) error { client.Close(); return nil },
	})
	return client, nil
}
