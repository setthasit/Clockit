package mongox

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.opentelemetry.io/contrib/instrumentation/go.mongodb.org/mongo-driver/v2/mongo/otelmongo"
	"go.uber.org/fx"

	"github.com/setthasit/clockit/backend/internal/config"
)

// New returns the app database. Handlers/stores take the database, never the client.
func New(lc fx.Lifecycle, cfg config.Config) (*mongo.Database, error) {
	client, err := mongo.Connect(options.Client().
		ApplyURI(cfg.MongoURI).
		SetMonitor(otelmongo.NewMonitor()))
	if err != nil {
		return nil, err
	}
	lc.Append(fx.Hook{
		OnStart: func(ctx context.Context) error { return client.Ping(ctx, nil) },
		OnStop:  func(ctx context.Context) error { return client.Disconnect(ctx) },
	})
	return client.Database(cfg.MongoDB), nil
}
