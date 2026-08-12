package user

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/mongox"
)

func testStore(t *testing.T) *Store {
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

	kek := make([]byte, 32)
	if _, err := rand.Read(kek); err != nil {
		t.Fatal(err)
	}
	env, err := crypto.NewEnvelope(config.Config{
		KEKMode:     "local",
		KEKLocalKey: base64.StdEncoding.EncodeToString(kek),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Real production constraints, not a hand-picked subset: the unique email
	// index is what makes the second-subject conflict reachable.
	if err := mongox.EnsureIndexes(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return NewStore(db, env)
}

func TestGetOrCreateIsIdempotentUnderRace(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	ident := auth.Identity{Sub: "auth0|race", Email: "Race@Example.com"}

	var wg sync.WaitGroup
	got := make([]*User, 4)
	errs := make([]error, 4)
	for i := range got {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i], errs[i] = s.GetOrCreate(ctx, ident)
		}()
	}
	wg.Wait()

	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	ids := make([]bson.ObjectID, len(got))
	for i, u := range got {
		ids[i] = u.ID
		if u.ID != got[0].ID {
			t.Fatalf("got differing user ids %v", ids)
		}
	}
	count, err := s.users.CountDocuments(ctx, bson.M{"auth0_sub": ident.Sub})
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("got %d user docs, want 1", count)
	}

	var stored User
	if err := s.users.FindOne(ctx, bson.M{"_id": ids[0]}).Decode(&stored); err != nil {
		t.Fatal(err)
	}
	if stored.Email != "race@example.com" {
		t.Fatalf("email not lowercased: %q", stored.Email)
	}
	if len(stored.DEKWrapped) == 0 {
		t.Fatal("wrapped DEK not stored")
	}
	// Losers of the race mint a DEK that is never persisted; returning it would
	// encrypt data under a key nothing can unwrap.
	for i, u := range got {
		if !bytes.Equal(u.DEKWrapped, stored.DEKWrapped) {
			t.Fatalf("caller %d returned a DEK that is not the stored one", i)
		}
	}
}

func TestGetOrCreateRejectsEmailOwnedByAnotherSubject(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	first, err := s.GetOrCreate(ctx, auth.Identity{Sub: "auth0|google", Email: "dup@example.com"})
	if err != nil {
		t.Fatal(err)
	}

	// Same person, second Auth0 connection: no account linking, so the email
	// unique index — not auth0_sub — is what rejects the insert.
	_, err = s.GetOrCreate(ctx, auth.Identity{Sub: "auth0|password", Email: "Dup@Example.com"})
	if !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("err = %v, want ErrEmailTaken", err)
	}

	count, err := s.users.CountDocuments(ctx, bson.M{"email": "dup@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("got %d user docs, want 1", count)
	}
	var stored User
	if err := s.users.FindOne(ctx, bson.M{"email": "dup@example.com"}).Decode(&stored); err != nil {
		t.Fatal(err)
	}
	if stored.ID != first.ID || stored.Auth0Sub != "auth0|google" {
		t.Fatalf("existing user was modified: %+v", stored)
	}
}

func TestGetOrCreateClaimsInvitations(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	employerID := bson.NewObjectID()
	insert := func(email, status string) bson.ObjectID {
		t.Helper()
		id := bson.NewObjectID()
		doc := bson.M{"_id": id, "employer_id": employerID, "email": email, "status": status}
		if _, err := s.memberships.InsertOne(ctx, doc); err != nil {
			t.Fatal(err)
		}
		return id
	}
	invited := insert("member@example.com", "invited")
	removed := insert("removed@example.com", "removed")
	other := insert("someone@example.com", "invited")

	unverified, err := s.GetOrCreate(ctx, auth.Identity{Sub: "auth0|a", Email: "member@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	assertMembership(t, s, invited, "invited", nil)

	verified, err := s.GetOrCreate(ctx, auth.Identity{
		Sub: "auth0|a", Email: "Member@Example.com", EmailVerified: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if verified.ID != unverified.ID {
		t.Fatal("same subject produced two users")
	}
	assertMembership(t, s, invited, "active", &verified.ID)

	if _, err := s.GetOrCreate(ctx, auth.Identity{
		Sub: "auth0|b", Email: "removed@example.com", EmailVerified: true,
	}); err != nil {
		t.Fatal(err)
	}
	assertMembership(t, s, removed, "removed", nil)
	assertMembership(t, s, other, "invited", nil)
}

func assertMembership(t *testing.T, s *Store, id bson.ObjectID, wantStatus string, wantUserID *bson.ObjectID) {
	t.Helper()
	var got struct {
		Status string         `bson:"status"`
		UserID *bson.ObjectID `bson:"user_id"`
	}
	if err := s.memberships.FindOne(context.Background(), bson.M{"_id": id}).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Status != wantStatus {
		t.Fatalf("status = %q, want %q", got.Status, wantStatus)
	}
	switch {
	case wantUserID == nil && got.UserID != nil:
		t.Fatalf("user_id = %v, want unset", got.UserID)
	case wantUserID != nil && (got.UserID == nil || *got.UserID != *wantUserID):
		t.Fatalf("user_id = %v, want %v", got.UserID, *wantUserID)
	}
}

func TestUpdate(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	u, err := s.GetOrCreate(ctx, auth.Identity{Sub: "auth0|u", Email: "u@example.com"})
	if err != nil {
		t.Fatal(err)
	}

	name := "Ada"
	if err := s.Update(ctx, u.ID, &name, []byte("sealed")); err != nil {
		t.Fatal(err)
	}
	if err := s.Update(ctx, u.ID, nil, nil); err != nil {
		t.Fatal(err)
	}

	var got User
	if err := s.users.FindOne(ctx, bson.M{"_id": u.ID}).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Name != name || string(got.PhoneEnc) != "sealed" {
		t.Fatalf("got %+v", got)
	}
}
