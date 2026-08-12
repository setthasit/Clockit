package mongox

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.uber.org/fx"
)

const locationPingTTLSeconds = 90 * 24 * 60 * 60

func indexes() map[string][]mongo.IndexModel {
	unique := func() *options.IndexOptionsBuilder { return options.Index().SetUnique(true) }

	return map[string][]mongo.IndexModel{
		"users": {
			{Keys: bson.D{{Key: "auth0_sub", Value: 1}}, Options: unique()},
			{Keys: bson.D{{Key: "email", Value: 1}}, Options: unique()},
		},
		"employers": {
			{Keys: bson.D{{Key: "owner_user_id", Value: 1}}},
		},
		"memberships": {
			{Keys: bson.D{{Key: "employer_id", Value: 1}, {Key: "email", Value: 1}}, Options: unique()},
			{Keys: bson.D{{Key: "user_id", Value: 1}}},
		},
		"time_entries": {
			{Keys: bson.D{{Key: "user_id", Value: 1}, {Key: "client_id", Value: 1}}, Options: unique()},
			// One open shift per user.
			{Keys: bson.D{{Key: "user_id", Value: 1}}, Options: unique().
				SetPartialFilterExpression(bson.D{{Key: "status", Value: "open"}})},
			{Keys: bson.D{{Key: "employer_id", Value: 1}, {Key: "clock_in.at", Value: 1}}},
			{Keys: bson.D{{Key: "user_id", Value: 1}, {Key: "clock_in.at", Value: 1}}},
		},
		"location_pings": {
			{Keys: bson.D{{Key: "entry_id", Value: 1}, {Key: "at", Value: 1}}},
			{Keys: bson.D{{Key: "created_at", Value: 1}}, Options: options.Index().
				SetExpireAfterSeconds(locationPingTTLSeconds)},
		},
		"tips": {
			{Keys: bson.D{{Key: "employer_id", Value: 1}, {Key: "date", Value: 1}}, Options: unique()},
		},
	}
}

// EnsureIndexes is idempotent: Mongo ignores CreateMany for indexes that already exist identically.
func EnsureIndexes(ctx context.Context, db *mongo.Database) error {
	for collection, models := range indexes() {
		if _, err := db.Collection(collection).Indexes().CreateMany(ctx, models); err != nil {
			return fmt.Errorf("ensure indexes on %s: %w", collection, err)
		}
	}
	return nil
}

func RegisterIndexes(lc fx.Lifecycle, db *mongo.Database) {
	lc.Append(fx.Hook{
		OnStart: func(ctx context.Context) error { return EnsureIndexes(ctx, db) },
	})
}
