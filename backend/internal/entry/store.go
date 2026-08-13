package entry

import (
	"context"
	"errors"
	"slices"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/user"
)

// ErrOpenEntryExists means the user is already clocked in — the partial unique
// index on {user_id} where status="open" is the enforcement point.
var ErrOpenEntryExists = errors.New("open entry exists")

// ErrEntryNotOpen means the shift was closed between the read and the close.
var ErrEntryNotOpen = errors.New("entry is not open")

// ErrAlreadyAssigned means the entry gained an employer before this assign
// landed. Assignment is one-way in v1, so there is nothing to reconcile.
var ErrAlreadyAssigned = errors.New("entry already has an employer")

// msTime matches BSON's millisecond datetime resolution, so the entry a handler
// returns is byte-identical to the one a later read decodes.
func msTime(t time.Time) time.Time { return t.UTC().Truncate(time.Millisecond) }

type Store struct {
	entries *mongo.Collection
	pings   *mongo.Collection
	env     *crypto.Envelope
}

func NewStore(db *mongo.Database, env *crypto.Envelope) *Store {
	return &Store{
		entries: db.Collection("time_entries"),
		pings:   db.Collection("location_pings"),
		env:     env,
	}
}

// ByClientID is the idempotency lookup: a replayed clock-in must return the
// original entry instead of starting a second shift. Returns nil on a miss.
func (s *Store) ByClientID(ctx context.Context, userID bson.ObjectID, clientID string) (*Entry, error) {
	return s.findOne(ctx, bson.M{"user_id": userID, "client_id": clientID})
}

// ByCloseClientID is the clock-out idempotency lookup. A close carries its own
// key space: matching a clock-in client_id here is impossible, because a
// replayed close is only ever recognised through close_client_id.
//
// ponytail: no index of its own — the lookup rides the user_id prefix of the
// existing indexes and scans one user's entries. Add a compound
// {user_id, close_client_id} index when per-user history is long enough to
// measure.
func (s *Store) ByCloseClientID(ctx context.Context, userID bson.ObjectID, clientID string) (*Entry, error) {
	return s.findOne(ctx, bson.M{"user_id": userID, "close_client_id": clientID, "status": statusClosed})
}

// ByID scopes the read to the owner, so a foreign entry reads exactly like a
// missing one and the endpoint never confirms which ids exist.
func (s *Store) ByID(ctx context.Context, userID, entryID bson.ObjectID) (*Entry, error) {
	return s.findOne(ctx, bson.M{"_id": entryID, "user_id": userID})
}

// List returns the user's entries newest first, bounded by the half-open window
// [from, to) on clock_in.at — either end nil is unbounded. Half-open so two
// adjacent ranges neither drop nor double-count a shift on the boundary.
//
// ponytail: unpaginated; the {user_id, clock_in.at} index serves the sort
// directly and a year of shifts is a few hundred documents. Add a limit and a
// cursor when one response gets large.
func (s *Store) List(ctx context.Context, userID bson.ObjectID, from, to *time.Time) ([]Entry, error) {
	return s.list(ctx, bson.M{"user_id": userID}, from, to)
}

// ListByEmployer is the owner's view of a team's shifts, same window semantics
// as List. Authorization is the caller's job: this filters on employer_id only.
func (s *Store) ListByEmployer(ctx context.Context, employerID bson.ObjectID, from, to *time.Time) ([]Entry, error) {
	return s.list(ctx, bson.M{"employer_id": employerID}, from, to)
}

func (s *Store) list(ctx context.Context, filter bson.M, from, to *time.Time) ([]Entry, error) {
	window := bson.M{}
	if from != nil {
		window["$gte"] = msTime(*from)
	}
	if to != nil {
		window["$lt"] = msTime(*to)
	}
	if len(window) > 0 {
		filter["clock_in.at"] = window
	}

	cur, err := s.entries.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "clock_in.at", Value: -1}}))
	if err != nil {
		return nil, err
	}
	out := []Entry{}
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Assign attaches an employer to a personal entry. location_verified is decided
// by the caller, which re-measured both fixes against the employer's anchor.
//
// ponytail: the employer_id: nil guard in the filter is the whole concurrency
// story — assignment is one-way, so the loser of a race is simply told the entry
// is already assigned rather than reconciled.
func (s *Store) Assign(ctx context.Context, e *Entry, employerID bson.ObjectID, verified bool) (*Entry, error) {
	res, err := s.entries.UpdateOne(ctx,
		bson.M{"_id": e.ID, "user_id": e.UserID, "employer_id": nil},
		bson.M{"$set": bson.M{"employer_id": employerID, "location_verified": verified}})
	if err != nil {
		return nil, err
	}
	if res.MatchedCount == 0 {
		return nil, ErrAlreadyAssigned
	}

	assigned := *e
	assigned.EmployerID = &employerID
	assigned.LocationVerified = verified
	return &assigned, nil
}

// OpenEntry returns the user's running shift, or nil when they are clocked out.
func (s *Store) OpenEntry(ctx context.Context, userID bson.ObjectID) (*Entry, error) {
	return s.findOne(ctx, bson.M{"user_id": userID, "status": statusOpen})
}

func (s *Store) findOne(ctx context.Context, filter bson.M) (*Entry, error) {
	var e Entry
	err := s.entries.FindOne(ctx, filter).Decode(&e)
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
//
// flags are stored with the entry rather than added afterwards: a verdict the
// caller can only reach once must not depend on a second command succeeding.
func (s *Store) ClockIn(ctx context.Context, u *user.User, employerID *bson.ObjectID, clientID string, f Fix, flags ...string) (*Entry, bool, error) {
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
		ClockIn:          ClockPoint{At: msTime(f.At), LocEnc: locEnc, AccuracyM: f.AccuracyM, Mocked: f.Mocked},
		LocationVerified: true,
		// Copied, and never nil: the document stores an empty array rather than
		// a null, which is what every reader of Flags expects.
		Flags:     append([]string{}, flags...),
		CreatedAt: msTime(time.Now()),
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

// ClockOut closes an open shift. Like ClockIn the fix is trusted: the handler
// has already run the location rules against the right anchor.
//
// ErrEntryNotOpen means another request closed the shift first; the caller
// decides whether that was this same close replayed.
//
// flags ride in the closing update for the same reason as in ClockIn.
func (s *Store) ClockOut(ctx context.Context, u *user.User, e *Entry, clientID string, f Fix, flags ...string) (*Entry, error) {
	locEnc, err := s.sealLoc(ctx, u, employer.LatLng{Lat: f.Lat, Lng: f.Lng})
	if err != nil {
		return nil, err
	}
	out := ClockPoint{At: msTime(f.At), LocEnc: locEnc, AccuracyM: f.AccuracyM, Mocked: f.Mocked}

	update := bson.M{"$set": bson.M{"clock_out": out, "status": statusClosed, "close_client_id": clientID}}
	if len(flags) > 0 {
		update["$addToSet"] = bson.M{"flags": bson.M{"$each": flags}}
	}
	// ponytail: the status guard in the filter is the entire concurrency story —
	// two racing closes, one winner, no transaction and no extra round trip.
	res, err := s.entries.UpdateOne(ctx, bson.M{"_id": e.ID, "status": statusOpen}, update)
	if err != nil {
		return nil, err
	}
	if res.MatchedCount == 0 {
		return nil, ErrEntryNotOpen
	}

	closed := *e
	closed.ClockOut = &out
	closed.Status = statusClosed
	closed.CloseClientID = clientID
	// Mirror $addToSet, so the entry handed back is the document that was
	// written. Cloned first: the copy must not append into e's array.
	closed.Flags = slices.Clone(e.Flags)
	for _, flag := range flags {
		if !slices.Contains(closed.Flags, flag) {
			closed.Flags = append(closed.Flags, flag)
		}
	}
	return &closed, nil
}

// LastPing returns the newest breadcrumb already on an entry, or nil when this
// batch is the first. It is the left-hand side of the speed check, so it must be
// read before the batch is inserted.
func (s *Store) LastPing(ctx context.Context, entryID bson.ObjectID) (*LocationPing, error) {
	var p LocationPing
	err := s.pings.FindOne(ctx,
		bson.M{"entry_id": entryID},
		options.FindOne().SetSort(bson.D{{Key: "at", Value: -1}})).Decode(&p)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// AddPings seals a batch of breadcrumbs under the user's DEK — one unwrap for
// the whole batch — and writes them in a single round trip. created_at is the
// TTL anchor, so it is the write time rather than the ping time: a batch flushed
// late still gets its full retention.
func (s *Store) AddPings(ctx context.Context, u *user.User, entryID bson.ObjectID, fixes []Fix) (int, error) {
	if len(fixes) == 0 {
		return 0, nil
	}
	dek, err := s.env.UnwrapDEK(ctx, u.ID.Hex(), u.DEKWrapped)
	if err != nil {
		return 0, err
	}
	now := msTime(time.Now())
	docs := make([]any, 0, len(fixes))
	for _, f := range fixes {
		locEnc, err := crypto.SealJSON(dek, employer.LatLng{Lat: f.Lat, Lng: f.Lng})
		if err != nil {
			return 0, err
		}
		docs = append(docs, LocationPing{
			ID:        bson.NewObjectID(),
			EntryID:   entryID,
			UserID:    u.ID,
			At:        msTime(f.At),
			LocEnc:    locEnc,
			CreatedAt: now,
		})
	}

	res, err := s.pings.InsertMany(ctx, docs)
	if err != nil {
		return 0, err
	}
	return len(res.InsertedIDs), nil
}

// Flag records an advisory verdict on an entry. $addToSet makes it idempotent,
// so a shift that keeps tripping the same rule carries the flag once.
//
// ponytail: no transaction with the ping insert — a flag is evidence about
// pings that are already stored, and losing it in a crash costs nothing a later
// batch cannot re-raise. That rationale is the precondition, not a licence: a
// verdict nothing re-raises belongs in the write it describes (see the flags
// argument of ClockIn and ClockOut), never here.
func (s *Store) Flag(ctx context.Context, e *Entry, flag string) error {
	_, err := s.entries.UpdateOne(ctx,
		bson.M{"_id": e.ID, "user_id": e.UserID},
		bson.M{"$addToSet": bson.M{"flags": flag}})
	return err
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
