package entry

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/user"
)

// ErrOpenEntryExists means the user is already clocked in — the partial unique
// index on {user_id} where status="open" is the enforcement point.
var ErrOpenEntryExists = errors.New("open entry exists")

type Store struct {
	entries *mongo.Collection
	env     *crypto.Envelope
}

func NewStore(db *mongo.Database, env *crypto.Envelope) *Store {
	return &Store{entries: db.Collection("time_entries"), env: env}
}

// ByClientID is the idempotency lookup: a replayed clock-in must return the
// original entry instead of starting a second shift. Returns nil on a miss.
func (s *Store) ByClientID(ctx context.Context, userID bson.ObjectID, clientID string) (*Entry, error) {
	var e Entry
	err := s.entries.FindOne(ctx, bson.M{"user_id": userID, "client_id": clientID}).Decode(&e)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// ClockIn opens a shift with the fix sealed under the user's DEK. The fix is
// trusted — the handler has already run the location rules, which is why the
// entry is stored location_verified: an employer entry passed the anchor check
// and a personal entry is its own anchor (design §4.5).
//
// The returned bool reports that an equivalent entry already existed, so the
// caller answers 200 instead of 201.
func (s *Store) ClockIn(ctx context.Context, u *user.User, employerID *bson.ObjectID, clientID string, f Fix) (*Entry, bool, error) {
	locEnc, err := s.sealLoc(ctx, u, employer.LatLng{Lat: f.Lat, Lng: f.Lng})
	if err != nil {
		return nil, false, err
	}
	e := &Entry{
		ID:               bson.NewObjectID(),
		UserID:           u.ID,
		EmployerID:       employerID,
		ClientID:         clientID,
		Status:           statusOpen,
		ClockIn:          ClockPoint{At: f.At.UTC(), LocEnc: locEnc, AccuracyM: f.AccuracyM, Mocked: f.Mocked},
		LocationVerified: true,
		Flags:            []string{},
		CreatedAt:        time.Now().UTC(),
	}

	_, err = s.entries.InsertOne(ctx, e)
	if mongo.IsDuplicateKeyError(err) {
		// Two indexes can reject this insert and the driver error does not say
		// which without parsing its name. Re-reading (user_id, client_id)
		// separates them: a hit means the caller replayed itself in parallel,
		// a miss means the partial open index blocked a second shift.
		existing, findErr := s.ByClientID(ctx, u.ID, clientID)
		if findErr != nil {
			return nil, false, findErr
		}
		if existing != nil {
			return existing, true, nil
		}
		return nil, false, ErrOpenEntryExists
	}
	if err != nil {
		return nil, false, err
	}
	return e, false, nil
}

func (s *Store) sealLoc(ctx context.Context, u *user.User, loc employer.LatLng) ([]byte, error) {
	dek, err := s.env.UnwrapDEK(ctx, u.ID.Hex(), u.DEKWrapped)
	if err != nil {
		return nil, err
	}
	return crypto.SealJSON(dek, loc)
}

// openLoc reverses sealLoc for the owner's own view of their entry.
func (s *Store) openLoc(ctx context.Context, u *user.User, enc []byte) (employer.LatLng, error) {
	dek, err := s.env.UnwrapDEK(ctx, u.ID.Hex(), u.DEKWrapped)
	if err != nil {
		return employer.LatLng{}, err
	}
	var loc employer.LatLng
	if err := crypto.OpenJSON(dek, enc, &loc); err != nil {
		return employer.LatLng{}, err
	}
	return loc, nil
}
