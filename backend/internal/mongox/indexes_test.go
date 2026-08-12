package mongox

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func testDB(t *testing.T) *mongo.Database {
	t.Helper()
	uri := os.Getenv("MONGO_URI")
	if uri == "" {
		t.Skip("MONGO_URI not set")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	db := client.Database(fmt.Sprintf("clockit_test_%d", time.Now().UnixNano()))
	t.Cleanup(func() {
		if err := db.Drop(context.Background()); err != nil {
			t.Error(err)
		}
		if err := client.Disconnect(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return db
}

func TestEnsureIndexes(t *testing.T) {
	ctx := context.Background()
	db := testDB(t)

	for range 2 {
		if err := EnsureIndexes(ctx, db); err != nil {
			t.Fatal(err)
		}
	}

	cursor, err := db.Collection("time_entries").Indexes().List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var specs []struct {
		Key                     bson.D `bson:"key"`
		Unique                  bool   `bson:"unique"`
		PartialFilterExpression bson.M `bson:"partialFilterExpression"`
	}
	if err := cursor.All(ctx, &specs); err != nil {
		t.Fatal(err)
	}

	var found bool
	for _, spec := range specs {
		if spec.Unique && len(spec.Key) == 1 && spec.Key[0].Key == "user_id" &&
			spec.PartialFilterExpression["status"] == "open" {
			found = true
		}
	}
	if !found {
		t.Fatalf("partial unique open-shift index missing, got %+v", specs)
	}
}
