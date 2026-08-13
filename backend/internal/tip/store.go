package tip

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type Store struct {
	tips *mongo.Collection
}

func NewStore(db *mongo.Database) *Store {
	return &Store{tips: db.Collection("tips")}
}

// Upsert writes a day's pool, creating the row on the first edit. employer_id
// and date come from the filter's equality terms on insert, so only created_at
// needs $setOnInsert.
func (s *Store) Upsert(ctx context.Context, employerID bson.ObjectID, date string, cents int64) error {
	filter := bson.M{"employer_id": employerID, "date": date}
	update := bson.M{
		"$set":         bson.M{"amount_cents": cents},
		"$setOnInsert": bson.M{"created_at": time.Now().UTC()},
	}
	opts := options.UpdateOne().SetUpsert(true)

	_, err := s.tips.UpdateOne(ctx, filter, update, opts)
	if mongo.IsDuplicateKeyError(err) {
		// Two first edits of the same day raced and the unique index rejected the
		// loser's insert. The row exists now, so the same write lands as a plain
		// update — last writer wins, which is what an overwrite endpoint means.
		_, err = s.tips.UpdateOne(ctx, filter, update, opts)
	}
	return err
}

// List returns an employer's pools oldest first, bounded by the inclusive day
// range [from, to] — either end empty is unbounded. Inclusive, unlike the
// half-open instant windows on entries: these bounds are days the caller named,
// and a report through "to" must carry that day's tip.
func (s *Store) List(ctx context.Context, employerID bson.ObjectID, from, to string) ([]Tip, error) {
	filter := bson.M{"employer_id": employerID}
	window := bson.M{}
	if from != "" {
		window["$gte"] = from
	}
	if to != "" {
		window["$lte"] = to
	}
	if len(window) > 0 {
		filter["date"] = window
	}

	cur, err := s.tips.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "date", Value: 1}}))
	if err != nil {
		return nil, err
	}
	out := []Tip{}
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}
