package user

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/crypto"
)

type Store struct {
	users       *mongo.Collection
	memberships *mongo.Collection
	env         *crypto.Envelope
}

func NewStore(db *mongo.Database, env *crypto.Envelope) *Store {
	return &Store{
		users:       db.Collection("users"),
		memberships: db.Collection("memberships"),
		env:         env,
	}
}

// GetOrCreate provisions the user just-in-time (design §4.3): there is no signup
// endpoint, the first authenticated request creates the document.
func (s *Store) GetOrCreate(ctx context.Context, ident auth.Identity) (*User, error) {
	email := strings.ToLower(ident.Email)
	u, err := s.findOrInsert(ctx, ident.Sub, email)
	if err != nil {
		return nil, err
	}
	// Invitations can arrive after the user exists, so this runs on every call,
	// not only on creation.
	if ident.EmailVerified {
		if err := s.claimInvitations(ctx, u.ID, email); err != nil {
			return nil, err
		}
	}
	return u, nil
}

func (s *Store) Update(ctx context.Context, id bson.ObjectID, name *string, phoneEnc []byte) error {
	set := bson.M{}
	if name != nil {
		set["name"] = *name
	}
	if len(phoneEnc) > 0 {
		set["phone_enc"] = phoneEnc
	}
	if len(set) == 0 {
		return nil
	}
	_, err := s.users.UpdateByID(ctx, id, bson.M{"$set": set})
	return err
}

// findOrInsert reads first so the steady-state path costs one query and no KMS
// call; the DEK is minted only on a miss. Two parallel first requests may both
// mint one, but $setOnInsert lets exactly one reach the document and the loser's
// DEK is discarded unused.
func (s *Store) findOrInsert(ctx context.Context, sub, email string) (*User, error) {
	var u User
	err := s.users.FindOne(ctx, bson.M{"auth0_sub": sub}).Decode(&u)
	if err == nil {
		return &u, nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return nil, err
	}

	_, wrapped, err := s.env.NewDEK(ctx)
	if err != nil {
		return nil, err
	}
	insert := bson.M{
		"auth0_sub":   sub,
		"email":       email,
		"name":        "",
		"dek_wrapped": wrapped,
		"created_at":  time.Now().UTC(),
	}
	err = s.users.FindOneAndUpdate(ctx,
		bson.M{"auth0_sub": sub},
		bson.M{"$setOnInsert": insert},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After),
	).Decode(&u)
	// Concurrent upserts against a unique index can surface a duplicate key
	// error instead of matching; the winner's document is there, so re-read it.
	if mongo.IsDuplicateKeyError(err) {
		err = s.users.FindOne(ctx, bson.M{"auth0_sub": sub}).Decode(&u)
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// claimInvitations binds memberships an employer created by email to this user.
// {user_id: nil} matches both null and a missing field, which is what unclaimed
// invitations look like. Only "invited" rows are claimed so a removed member is
// never silently reactivated by logging in.
func (s *Store) claimInvitations(ctx context.Context, userID bson.ObjectID, email string) error {
	_, err := s.memberships.UpdateMany(ctx,
		bson.M{"email": email, "user_id": nil, "status": "invited"},
		bson.M{"$set": bson.M{"user_id": userID, "status": "active"}},
	)
	return err
}
