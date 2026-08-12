package employer

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/setthasit/clockit/backend/internal/crypto"
)

// ErrNotFound covers both "no such employer" and "not yours": handlers map it to
// 404 either way, so ownership failures cannot be used to probe which employer
// IDs exist.
var ErrNotFound = errors.New("employer not found")

type Store struct {
	employers *mongo.Collection
	env       *crypto.Envelope
}

func NewStore(db *mongo.Database, env *crypto.Envelope) *Store {
	return &Store{employers: db.Collection("employers"), env: env}
}

// Create mints the employer DEK and seals the anchor with it, so the plaintext
// DEK never leaves this package. Name and timezone are trusted — handlers
// validate them.
func (s *Store) Create(ctx context.Context, ownerUserID bson.ObjectID, name, timezone string, anchor LatLng) (*Employer, error) {
	dek, wrapped, err := s.env.NewDEK(ctx)
	if err != nil {
		return nil, err
	}
	anchorEnc, err := crypto.SealJSON(dek, anchor)
	if err != nil {
		return nil, err
	}
	e := &Employer{
		ID:          bson.NewObjectID(),
		OwnerUserID: ownerUserID,
		Name:        name,
		Timezone:    timezone,
		AnchorEnc:   anchorEnc,
		DEKWrapped:  wrapped,
		CreatedAt:   time.Now().UTC(),
	}
	if _, err := s.employers.InsertOne(ctx, e); err != nil {
		return nil, err
	}
	return e, nil
}

func (s *Store) ListByOwner(ctx context.Context, ownerUserID bson.ObjectID) ([]Employer, error) {
	cur, err := s.employers.Find(ctx, bson.M{"owner_user_id": ownerUserID})
	if err != nil {
		return nil, err
	}
	out := []Employer{}
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetOwned is the authorization gate every employer-scoped handler runs first.
func (s *Store) GetOwned(ctx context.Context, employerID, ownerUserID bson.ObjectID) (*Employer, error) {
	var e Employer
	err := s.employers.FindOne(ctx, bson.M{"_id": employerID, "owner_user_id": ownerUserID}).Decode(&e)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// Update applies the fields that were sent; a new anchor is re-sealed with the
// employer's existing DEK. Nil fields are left untouched.
func (s *Store) Update(ctx context.Context, employerID, ownerUserID bson.ObjectID, name, timezone *string, anchor *LatLng) error {
	e, err := s.GetOwned(ctx, employerID, ownerUserID)
	if err != nil {
		return err
	}
	set := bson.M{}
	if name != nil {
		set["name"] = *name
	}
	if timezone != nil {
		set["timezone"] = *timezone
	}
	if anchor != nil {
		dek, err := s.env.UnwrapDEK(ctx, e.ID.Hex(), e.DEKWrapped)
		if err != nil {
			return err
		}
		if set["anchor_enc"], err = crypto.SealJSON(dek, *anchor); err != nil {
			return err
		}
	}
	if len(set) == 0 {
		return nil
	}
	// Owner-scoped write filter, not UpdateByID: ownership is re-checked at write
	// time, so a transfer between the read above and here cannot be overwritten.
	_, err = s.employers.UpdateOne(ctx, bson.M{"_id": employerID, "owner_user_id": ownerUserID}, bson.M{"$set": set})
	return err
}

func (s *Store) DecryptAnchor(ctx context.Context, e *Employer) (LatLng, error) {
	dek, err := s.env.UnwrapDEK(ctx, e.ID.Hex(), e.DEKWrapped)
	if err != nil {
		return LatLng{}, err
	}
	var anchor LatLng
	if err := crypto.OpenJSON(dek, e.AnchorEnc, &anchor); err != nil {
		return LatLng{}, err
	}
	return anchor, nil
}
