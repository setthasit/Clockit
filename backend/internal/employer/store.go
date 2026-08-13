package employer

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/setthasit/clockit/backend/internal/crypto"
)

// ErrNotFound covers both "no such employer" and "not yours": handlers map it to
// 404 either way, so ownership failures cannot be used to probe which employer
// IDs exist.
var ErrNotFound = errors.New("employer not found")

// ErrAlreadyMember is a live (invited or active) membership for the address; a
// removed one is revived instead of colliding.
var ErrAlreadyMember = errors.New("already a member")

type Store struct {
	employers   *mongo.Collection
	memberships *mongo.Collection
	// ponytail: read-only view of the users collection for the name join and the
	// invitation claim; the user package owns every write to it.
	users *mongo.Collection
	env   *crypto.Envelope
}

func NewStore(db *mongo.Database, env *crypto.Envelope) *Store {
	return &Store{
		employers:   db.Collection("employers"),
		memberships: db.Collection("memberships"),
		users:       db.Collection("users"),
		env:         env,
	}
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
	cur, err := s.employers.Find(ctx, bson.M{"owner_user_id": ownerUserID}, options.Find().SetSort(bson.D{{Key: "created_at", Value: 1}}))
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

// Get loads an employer without an ownership check: callers on the member side
// (clock-in, tips report) authorize through ActiveMembership instead.
func (s *Store) Get(ctx context.Context, employerID bson.ObjectID) (*Employer, error) {
	var e Employer
	err := s.employers.FindOne(ctx, bson.M{"_id": employerID}).Decode(&e)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// ActiveMembership is the employee-side authorization gate: ErrNotFound when the
// user holds no active membership, which callers report as NOT_MEMBER.
func (s *Store) ActiveMembership(ctx context.Context, employerID, userID bson.ObjectID) (*Membership, error) {
	var m Membership
	err := s.memberships.FindOne(ctx, bson.M{
		"employer_id": employerID,
		"user_id":     userID,
		"status":      statusActive,
	}).Decode(&m)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
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

// UserRef is the read-only slice of the users collection that employer-owned
// views join in: who a membership or a time entry belongs to, nothing more.
type UserRef struct {
	ID    bson.ObjectID `bson:"_id" json:"id"`
	Name  string        `bson:"name" json:"name"`
	Email string        `bson:"email" json:"email"`
}

// AddMember invites an address, reviving a previously removed membership rather
// than inserting a second one — the (employer_id, email) index is unique with no
// status filter, so the removed row still owns the slot. The upsert filter pins
// status to "removed": a live membership therefore fails to match, the upsert
// falls through to an insert and the unique index turns it into ErrAlreadyMember
// in one round trip. A revived membership keeps its rate: it is the same
// employment relationship.
func (s *Store) AddMember(ctx context.Context, e *Employer, email string) (*Member, error) {
	set := bson.M{"status": statusInvited}
	name := ""
	u, err := s.userByEmail(ctx, email)
	if err != nil {
		return nil, err
	}
	if u != nil {
		// ponytail: a user document proves the address authenticated at least
		// once, not that Auth0 reported the email verified — the login-time claim
		// (user.claimInvitations) is the verified path. Persist email_verified on
		// the user document if an unverified account must stay merely invited.
		set["user_id"] = u.ID
		set["status"] = statusActive
		name = u.Name
	}

	var m Membership
	err = s.memberships.FindOneAndUpdate(ctx,
		bson.M{"employer_id": e.ID, "email": email, "status": statusRemoved},
		bson.M{"$set": set, "$setOnInsert": bson.M{
			"employer_id": e.ID,
			"email":       email,
			"created_at":  time.Now().UTC(),
		}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After),
	).Decode(&m)
	if mongo.IsDuplicateKeyError(err) {
		return nil, ErrAlreadyMember
	}
	if err != nil {
		return nil, err
	}
	return s.member(ctx, e, &m, name)
}

// ListMembers returns every membership including removed ones: the employer UI
// lists them in a "removed" section and can re-invite from there.
func (s *Store) ListMembers(ctx context.Context, e *Employer) ([]Member, error) {
	cur, err := s.memberships.Find(ctx, bson.M{"employer_id": e.ID},
		options.Find().SetSort(bson.D{{Key: "created_at", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var docs []Membership
	if err := cur.All(ctx, &docs); err != nil {
		return nil, err
	}

	ids := make([]bson.ObjectID, 0, len(docs))
	for i := range docs {
		if docs[i].UserID != nil {
			ids = append(ids, *docs[i].UserID)
		}
	}
	users, err := s.UsersByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]Member, 0, len(docs))
	for i := range docs {
		name := ""
		if docs[i].UserID != nil {
			name = users[*docs[i].UserID].Name
		}
		m, err := s.member(ctx, e, &docs[i], name)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, nil
}

// SetMemberRate seals the rate with the employer's DEK. Removed memberships are
// not writable — reviving comes first.
func (s *Store) SetMemberRate(ctx context.Context, e *Employer, membershipID bson.ObjectID, cents int64) error {
	dek, err := s.env.UnwrapDEK(ctx, e.ID.Hex(), e.DEKWrapped)
	if err != nil {
		return err
	}
	enc, err := crypto.SealJSON(dek, cents)
	if err != nil {
		return err
	}
	return s.updateMember(ctx, e.ID, membershipID, bson.M{"hourly_rate_cents_enc": enc})
}

// RemoveMember is a soft delete (design §11.5): time entries keep referring to
// the user, and user_id stays so a later revival re-links the same person.
func (s *Store) RemoveMember(ctx context.Context, employerID, membershipID bson.ObjectID) error {
	return s.updateMember(ctx, employerID, membershipID, bson.M{"status": statusRemoved})
}

func (s *Store) updateMember(ctx context.Context, employerID, membershipID bson.ObjectID, set bson.M) error {
	res, err := s.memberships.UpdateOne(ctx, bson.M{
		"_id":         membershipID,
		"employer_id": employerID,
		"status":      bson.M{"$ne": statusRemoved},
	}, bson.M{"$set": set})
	if err != nil {
		return err
	}
	if res.MatchedCount == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) member(ctx context.Context, e *Employer, m *Membership, name string) (*Member, error) {
	out := &Member{ID: m.ID, Email: m.Email, Status: m.Status, Name: name}
	if len(m.HourlyRateCentsEnc) == 0 {
		return out, nil
	}
	dek, err := s.env.UnwrapDEK(ctx, e.ID.Hex(), e.DEKWrapped)
	if err != nil {
		return nil, err
	}
	var cents int64
	if err := crypto.OpenJSON(dek, m.HourlyRateCentsEnc, &cents); err != nil {
		return nil, err
	}
	out.HourlyRateCents = &cents
	return out, nil
}

func (s *Store) userByEmail(ctx context.Context, email string) (*UserRef, error) {
	var u UserRef
	err := s.users.FindOne(ctx, bson.M{"email": email}).Decode(&u)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// UsersByID resolves a batch of user ids in one round trip. Missing ids are
// simply absent from the map: a membership can point at a user document that a
// caller is no longer entitled to see, and an empty name is a better answer
// than a failed page.
func (s *Store) UsersByID(ctx context.Context, ids []bson.ObjectID) (map[bson.ObjectID]UserRef, error) {
	out := map[bson.ObjectID]UserRef{}
	if len(ids) == 0 {
		return out, nil
	}
	cur, err := s.users.Find(ctx, bson.M{"_id": bson.M{"$in": ids}})
	if err != nil {
		return nil, err
	}
	var found []UserRef
	if err := cur.All(ctx, &found); err != nil {
		return nil, err
	}
	for _, u := range found {
		out[u.ID] = u
	}
	return out, nil
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
