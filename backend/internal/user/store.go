package user

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/crypto"
)

// ErrEmailTaken means the address is already registered under a different
// auth0_sub. Auth0 has no account linking across our connections, so the same
// person signing in with a second connection lands here.
var ErrEmailTaken = errors.New("email already registered to another account")

type Store struct {
	users       *mongo.Collection
	memberships *mongo.Collection
	employers   *mongo.Collection
	env         *crypto.Envelope
}

func NewStore(db *mongo.Database, env *crypto.Envelope) *Store {
	return &Store{
		users:       db.Collection("users"),
		memberships: db.Collection("memberships"),
		employers:   db.Collection("employers"),
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
	// not only on creation. An empty email is skipped rather than matched on:
	// AddMember stores a parsed address, so "" binds nothing today, and a filter
	// that would claim every membership with a blank email is not worth leaving
	// one careless write away from working.
	if ident.EmailVerified && email != "" {
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

// employerDoc is the read-only slice of the employers collection /v1/me needs.
//
// ponytail: the employer join lives in the user package until a second package
// needs it; the employer package owns every write to that collection.
type employerDoc struct {
	ID         bson.ObjectID `bson:"_id"`
	Name       string        `bson:"name"`
	Timezone   string        `bson:"timezone"`
	AnchorEnc  []byte        `bson:"anchor_enc"`
	DEKWrapped []byte        `bson:"dek_wrapped"`
}

type membershipDoc struct {
	ID         bson.ObjectID `bson:"_id"`
	EmployerID bson.ObjectID `bson:"employer_id"`
	Status     string        `bson:"status"`
}

// ActiveMemberships lists the employers the user may clock in for. Invited rows
// are not returned (nothing is bound to the user yet) and removed rows would be
// rejected at clock-in anyway.
func (s *Store) ActiveMemberships(ctx context.Context, userID bson.ObjectID) ([]Membership, error) {
	var docs []membershipDoc
	cur, err := s.memberships.Find(ctx, bson.M{"user_id": userID, "status": "active"})
	if err != nil {
		return nil, err
	}
	if err := cur.All(ctx, &docs); err != nil {
		return nil, err
	}

	employers, err := s.employersByID(ctx, docs)
	if err != nil {
		return nil, err
	}

	out := make([]Membership, 0, len(docs))
	for _, d := range docs {
		e, ok := employers[d.EmployerID]
		if !ok {
			continue
		}
		anchor, err := s.openAnchor(ctx, e)
		// One employer with an unreadable anchor must not blank out the whole
		// profile screen; the membership is dropped and the failure logged.
		if err != nil {
			slog.ErrorContext(ctx, "anchor decrypt failed, skipping membership",
				"employer_id", e.ID.Hex(), "error", err)
			continue
		}
		out = append(out, Membership{
			ID:     d.ID,
			Status: d.Status,
			Employer: Employer{
				ID:       e.ID,
				Name:     e.Name,
				Anchor:   anchor,
				Timezone: e.Timezone,
			},
		})
	}
	return out, nil
}

func (s *Store) employersByID(ctx context.Context, docs []membershipDoc) (map[bson.ObjectID]employerDoc, error) {
	ids := make([]bson.ObjectID, 0, len(docs))
	for _, d := range docs {
		ids = append(ids, d.EmployerID)
	}
	out := make(map[bson.ObjectID]employerDoc, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := s.employers.Find(ctx, bson.M{"_id": bson.M{"$in": ids}})
	if err != nil {
		return nil, err
	}
	var found []employerDoc
	if err := cur.All(ctx, &found); err != nil {
		return nil, err
	}
	for _, e := range found {
		out[e.ID] = e
	}
	return out, nil
}

func (s *Store) openAnchor(ctx context.Context, e employerDoc) (Anchor, error) {
	dek, err := s.env.UnwrapDEK(ctx, e.ID.Hex(), e.DEKWrapped)
	if err != nil {
		return Anchor{}, err
	}
	var anchor Anchor
	if err := crypto.OpenJSON(dek, e.AnchorEnc, &anchor); err != nil {
		return Anchor{}, err
	}
	return anchor, nil
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
	// A duplicate key here is either auth0_sub (lost the insert race, the
	// winner's document is there to re-read) or email (another subject owns the
	// address). The raw E11000 must not escape: it embeds the email and errors
	// are recorded on traces.
	if mongo.IsDuplicateKeyError(err) {
		err = s.users.FindOne(ctx, bson.M{"auth0_sub": sub}).Decode(&u)
		if errors.Is(err, mongo.ErrNoDocuments) {
			err = ErrEmailTaken
		}
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
