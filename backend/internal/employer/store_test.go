package employer

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

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
	if err := mongox.EnsureIndexes(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return NewStore(db, env)
}

func testEmployer(t *testing.T, s *Store) *Employer {
	t.Helper()
	e, err := s.Create(context.Background(), bson.NewObjectID(), "Acme", "Asia/Bangkok", LatLng{Lat: 1, Lng: 2})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestAddMemberInvitesClaimsAndRejectsDuplicates(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	e := testEmployer(t, s)

	invited, err := s.AddMember(ctx, e, "new@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if invited.Status != statusInvited || invited.Name != "" || invited.HourlyRateCents != nil {
		t.Fatalf("member = %+v, want a bare invitation", invited)
	}

	// An address that already has a user document is claimed on the spot.
	joined := bson.NewObjectID()
	if _, err := s.users.InsertOne(ctx, bson.M{"_id": joined, "email": "joined@example.com", "name": "Dao"}); err != nil {
		t.Fatal(err)
	}
	active, err := s.AddMember(ctx, e, "joined@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if active.Status != statusActive || active.Name != "Dao" {
		t.Fatalf("member = %+v, want active and named", active)
	}

	for _, email := range []string{"new@example.com", "joined@example.com"} {
		if _, err := s.AddMember(ctx, e, email); !errors.Is(err, ErrAlreadyMember) {
			t.Fatalf("re-adding %s: err = %v, want ErrAlreadyMember", email, err)
		}
	}
	// The same address under a different employer is a different membership.
	if _, err := s.AddMember(ctx, testEmployer(t, s), "new@example.com"); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveThenReAddRevivesTheSameMembership(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	e := testEmployer(t, s)

	added, err := s.AddMember(ctx, e, "back@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetMemberRate(ctx, e, added.ID, 1800); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveMember(ctx, e.ID, added.ID); err != nil {
		t.Fatal(err)
	}
	// Removed rows are not writable and cannot be removed twice.
	if err := s.RemoveMember(ctx, e.ID, added.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if err := s.SetMemberRate(ctx, e, added.ID, 1900); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}

	revived, err := s.AddMember(ctx, e, "back@example.com")
	if err != nil {
		t.Fatal(err)
	}
	// Same document, same employment relationship: the rate survives.
	if revived.ID != added.ID || revived.Status != statusInvited {
		t.Fatalf("revived = %+v, want %s invited", revived, added.ID.Hex())
	}
	if revived.HourlyRateCents == nil || *revived.HourlyRateCents != 1800 {
		t.Fatalf("rate = %v, want 1800", revived.HourlyRateCents)
	}
	members, err := s.ListMembers(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 {
		t.Fatalf("got %d members, want 1: %+v", len(members), members)
	}
}

func TestSetMemberRateSealsWithEmployerDEK(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	e := testEmployer(t, s)
	m, err := s.AddMember(ctx, e, "paid@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetMemberRate(ctx, e, m.ID, 2200); err != nil {
		t.Fatal(err)
	}

	var stored Membership
	if err := s.memberships.FindOne(ctx, bson.M{"_id": m.ID}).Decode(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored.HourlyRateCentsEnc, []byte("2200")) {
		t.Fatalf("rate is not sealed: %q", stored.HourlyRateCentsEnc)
	}
	members, err := s.ListMembers(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 || members[0].HourlyRateCents == nil || *members[0].HourlyRateCents != 2200 {
		t.Fatalf("members = %+v, want one at 2200", members)
	}
	// Another employer's membership id must not be writable through this employer.
	if err := s.SetMemberRate(ctx, testEmployer(t, s), m.ID, 100); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestCreateSealsAnchor(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	owner := bson.NewObjectID()
	anchor := LatLng{Lat: 13.7563, Lng: 100.5018}

	e, err := s.Create(ctx, owner, "Acme", "Asia/Bangkok", anchor)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.DEKWrapped) == 0 || len(e.AnchorEnc) == 0 {
		t.Fatalf("employer stored without envelope: %+v", e)
	}

	var stored Employer
	if err := s.employers.FindOne(ctx, bson.M{"_id": e.ID}).Decode(&stored); err != nil {
		t.Fatal(err)
	}
	// The coordinates must not be readable without the DEK.
	if bytes.Contains(stored.AnchorEnc, []byte("lat")) {
		t.Fatalf("anchor is not sealed: %q", stored.AnchorEnc)
	}
	got, err := s.DecryptAnchor(ctx, &stored)
	if err != nil {
		t.Fatal(err)
	}
	if got != anchor {
		t.Fatalf("anchor = %+v, want %+v", got, anchor)
	}
	if stored.OwnerUserID != owner || stored.Name != "Acme" || stored.Timezone != "Asia/Bangkok" {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestGetOwnedRejectsOtherOwners(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	owner := bson.NewObjectID()
	e, err := s.Create(ctx, owner, "Acme", "Asia/Bangkok", LatLng{Lat: 1, Lng: 2})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.GetOwned(ctx, e.ID, owner); err != nil {
		t.Fatal(err)
	}
	// A stranger and a missing ID must be indistinguishable.
	if _, err := s.GetOwned(ctx, e.ID, bson.NewObjectID()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if _, err := s.GetOwned(ctx, bson.NewObjectID(), owner); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestListByOwnerIsScoped(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	owner, other := bson.NewObjectID(), bson.NewObjectID()
	mine, err := s.Create(ctx, owner, "Acme", "Asia/Bangkok", LatLng{Lat: 1, Lng: 2})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(ctx, other, "Theirs", "Asia/Bangkok", LatLng{Lat: 3, Lng: 4}); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListByOwner(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != mine.ID {
		t.Fatalf("got %d employers, want only %s: %+v", len(got), mine.ID.Hex(), got)
	}
	if empty, err := s.ListByOwner(ctx, bson.NewObjectID()); err != nil || len(empty) != 0 {
		t.Fatalf("got %+v, %v, want empty", empty, err)
	}
}

func TestUpdateIsPartialAndOwnerScoped(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	owner := bson.NewObjectID()
	e, err := s.Create(ctx, owner, "Acme", "Asia/Bangkok", LatLng{Lat: 1, Lng: 2})
	if err != nil {
		t.Fatal(err)
	}

	name := "Acme Two"
	moved := LatLng{Lat: 49.2827, Lng: -123.1207}
	if err := s.Update(ctx, e.ID, owner, &name, nil, &moved); err != nil {
		t.Fatal(err)
	}
	updated, err := s.GetOwned(ctx, e.ID, owner)
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := s.DecryptAnchor(ctx, updated)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != name || updated.Timezone != "Asia/Bangkok" || anchor != moved {
		t.Fatalf("got name %q tz %q anchor %+v", updated.Name, updated.Timezone, anchor)
	}

	if err := s.Update(ctx, e.ID, owner, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	// A non-owner must not be able to rename an employer it can't even read.
	stranger := "Hijacked"
	if err := s.Update(ctx, e.ID, bson.NewObjectID(), &stranger, nil, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	unchanged, err := s.GetOwned(ctx, e.ID, owner)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Name != name {
		t.Fatalf("name = %q, want %q", unchanged.Name, name)
	}
}
