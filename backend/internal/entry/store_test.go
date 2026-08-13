package entry

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

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/mongox"
	"github.com/setthasit/clockit/backend/internal/user"
)

func testStore(t *testing.T) (*Store, *user.User) {
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
	// The open-shift and idempotency guarantees are index behaviour: without the
	// indexes these tests would pass against duplicated documents.
	if err := mongox.EnsureIndexes(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	_, wrapped, err := env.NewDEK(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return NewStore(db, env), &user.User{ID: bson.NewObjectID(), DEKWrapped: wrapped}
}

func testFix() Fix {
	return Fix{Lat: 13.7563, Lng: 100.5018, AccuracyM: 10, At: time.Now().UTC()}
}

func TestClockInSealsTheFix(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)

	e, replayed, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil || replayed {
		t.Fatalf("ClockIn = %v, %v", replayed, err)
	}
	if e.Status != statusOpen || !e.LocationVerified {
		t.Fatalf("entry = %+v, want an open verified entry", e)
	}

	var stored Entry
	if err := s.entries.FindOne(ctx, bson.M{"_id": e.ID}).Decode(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored.ClockIn.LocEnc, []byte("13.75")) {
		t.Fatalf("location is not sealed: %q", stored.ClockIn.LocEnc)
	}
	loc, err := s.openLoc(ctx, u, stored.ClockIn.LocEnc)
	if err != nil {
		t.Fatal(err)
	}
	if loc.Lat != 13.7563 || loc.Lng != 100.5018 {
		t.Fatalf("loc = %+v", loc)
	}
}

// The outbox can flush the same clock-in twice at once: both callers must get
// the one entry, not a duplicate-key error.
func TestClockInIsIdempotentUnderParallelReplay(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)

	var wg sync.WaitGroup
	ids := make([]bson.ObjectID, 2)
	errs := make([]error, 2)
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e, _, err := s.ClockIn(ctx, u, nil, "same-client-id", testFix())
			if errs[i] = err; err == nil {
				ids[i] = e.ID
			}
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if ids[0] != ids[1] {
		t.Fatalf("ids = %s, %s, want the same entry", ids[0].Hex(), ids[1].Hex())
	}
	n, err := s.entries.CountDocuments(ctx, bson.M{"user_id": u.ID})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("got %d entries, want 1", n)
	}
}

// A different client_id while a shift is open is a second clock-in, and the
// partial unique index — not the idempotency index — is what rejects it.
func TestClockInRejectsASecondOpenShift(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)

	if _, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.ClockIn(ctx, u, nil, "c-2", testFix()); !errors.Is(err, ErrOpenEntryExists) {
		t.Fatalf("err = %v, want ErrOpenEntryExists", err)
	}
	// Another user's open shift is none of this one's business.
	other := &user.User{ID: bson.NewObjectID(), DEKWrapped: u.DEKWrapped}
	if _, _, err := s.ClockIn(ctx, other, nil, "c-1", testFix()); err != nil {
		t.Fatal(err)
	}
}

func TestByClientIDIsScopedToTheUser(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	e, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil {
		t.Fatal(err)
	}

	found, err := s.ByClientID(ctx, u.ID, "c-1")
	if err != nil || found == nil || found.ID != e.ID {
		t.Fatalf("ByClientID = %+v, %v", found, err)
	}
	for _, tc := range []struct{ userID, clientID string }{
		{bson.NewObjectID().Hex(), "c-1"},
		{u.ID.Hex(), "c-2"},
	} {
		id, err := bson.ObjectIDFromHex(tc.userID)
		if err != nil {
			t.Fatal(err)
		}
		got, err := s.ByClientID(ctx, id, tc.clientID)
		if err != nil || got != nil {
			t.Fatalf("ByClientID(%v) = %+v, %v, want nil", tc, got, err)
		}
	}
}
