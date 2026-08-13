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
	"go.mongodb.org/mongo-driver/v2/event"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/mongox"
	"github.com/setthasit/clockit/backend/internal/user"
)

// writeLog records the write commands the driver sends. It exists for one
// assertion: a flag that cannot be re-raised has to ride in the same command as
// the entry it describes, and only the command stream shows whether it did.
type writeLog struct {
	mu  sync.Mutex
	cmd []writeCmd
}

type writeCmd struct{ name, collection string }

var writeCommands = map[string]bool{"insert": true, "update": true, "findAndModify": true, "delete": true}

func (l *writeLog) monitor() *event.CommandMonitor {
	return &event.CommandMonitor{Started: func(_ context.Context, e *event.CommandStartedEvent) {
		// Every command names its collection in the field named after itself.
		coll, ok := e.Command.Lookup(e.CommandName).StringValueOK()
		if !ok || !writeCommands[e.CommandName] {
			return
		}
		l.mu.Lock()
		defer l.mu.Unlock()
		l.cmd = append(l.cmd, writeCmd{name: e.CommandName, collection: coll})
	}}
}

// on returns the write commands sent to one collection since the last reset.
func (l *writeLog) on(collection string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []string{}
	for _, c := range l.cmd {
		if c.collection == collection {
			out = append(out, c.name)
		}
	}
	return out
}

func (l *writeLog) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cmd = nil
}

// testDB is shared with the handler tests, which need the same database and
// envelope for the user and employer stores as well.
func testDB(t *testing.T) (*mongo.Database, *crypto.Envelope) {
	db, env, _ := testDBWithWrites(t)
	return db, env
}

func testDBWithWrites(t *testing.T) (*mongo.Database, *crypto.Envelope, *writeLog) {
	t.Helper()
	uri := os.Getenv("MONGO_URI")
	if uri == "" {
		t.Skip("MONGO_URI not set")
	}
	writes := &writeLog{}
	client, err := mongo.Connect(options.Client().ApplyURI(uri).SetMonitor(writes.monitor()))
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
	return db, env, writes
}

func testStore(t *testing.T) (*Store, *user.User) {
	t.Helper()
	db, env := testDB(t)
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

func TestClockOutClosesTheShift(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	in, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil {
		t.Fatal(err)
	}

	f := testFix()
	f.At = in.ClockIn.At.Add(time.Hour)
	closed, err := s.ClockOut(ctx, u, in, "close-1", f)
	if err != nil {
		t.Fatal(err)
	}
	if closed.Status != statusClosed || closed.ClockOut == nil {
		t.Fatalf("entry = %+v, want a closed entry with a clock-out point", closed)
	}

	stored, err := s.ByCloseClientID(ctx, u.ID, "close-1")
	if err != nil || stored == nil || stored.ID != in.ID {
		t.Fatalf("ByCloseClientID = %+v, %v", stored, err)
	}
	// The returned entry must survive a round trip through BSON unchanged, or a
	// replay would answer with different timestamps than the original close.
	if !stored.ClockOut.At.Equal(closed.ClockOut.At) || !stored.CreatedAt.Equal(closed.CreatedAt) {
		t.Fatalf("stored %+v differs from returned %+v", stored.ClockOut.At, closed.ClockOut.At)
	}
	if bytes.Contains(stored.ClockOut.LocEnc, []byte("13.75")) {
		t.Fatalf("clock-out location is not sealed: %q", stored.ClockOut.LocEnc)
	}
	loc, err := s.openLoc(ctx, u, stored.ClockOut.LocEnc)
	if err != nil || loc.Lat != f.Lat || loc.Lng != f.Lng {
		t.Fatalf("loc = %+v, %v", loc, err)
	}

	open, err := s.OpenEntry(ctx, u.ID)
	if err != nil || open != nil {
		t.Fatalf("OpenEntry = %+v, %v, want nil", open, err)
	}
	if _, err := s.ClockOut(ctx, u, in, "close-2", f); !errors.Is(err, ErrEntryNotOpen) {
		t.Fatalf("second close = %v, want ErrEntryNotOpen", err)
	}
}

// The outbox can flush the same clock-out twice at once: exactly one writes, and
// the loser can still recognise its own close through close_client_id.
func TestClockOutRaceHasOneWinner(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	in, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil {
		t.Fatal(err)
	}
	f := testFix()
	f.At = in.ClockIn.At.Add(time.Hour)

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = s.ClockOut(ctx, u, in, "close-1", f)
		}()
	}
	wg.Wait()

	won := 0
	for i, err := range errs {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, ErrEntryNotOpen):
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if won != 1 {
		t.Fatalf("%d calls closed the shift, want 1", won)
	}
	replay, err := s.ByCloseClientID(ctx, u.ID, "close-1")
	if err != nil || replay == nil || replay.ID != in.ID {
		t.Fatalf("ByCloseClientID = %+v, %v", replay, err)
	}
}

// Assignment is one-way: two racing assigns must not both "succeed" and leave
// the loser's location_verified verdict on the entry.
func TestAssignIsOneWayUnderRace(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	e, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil {
		t.Fatal(err)
	}
	employerID := bson.NewObjectID()

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = s.Assign(ctx, e, employerID, false)
		}()
	}
	wg.Wait()

	won := 0
	for i, err := range errs {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, ErrAlreadyAssigned):
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if won != 1 {
		t.Fatalf("%d calls assigned the entry, want 1", won)
	}

	stored, err := s.ByID(ctx, u.ID, e.ID)
	if err != nil || stored == nil {
		t.Fatalf("ByID = %+v, %v", stored, err)
	}
	if stored.EmployerID == nil || *stored.EmployerID != employerID || stored.LocationVerified {
		t.Fatalf("stored = %+v, want employer %s and location_verified false", stored, employerID.Hex())
	}
	// A second employer cannot take over an already-assigned entry.
	if _, err := s.Assign(ctx, e, bson.NewObjectID(), true); !errors.Is(err, ErrAlreadyAssigned) {
		t.Fatalf("re-assign = %v, want ErrAlreadyAssigned", err)
	}
}

func TestAssignKeepsVerifiedVerdict(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	e, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil {
		t.Fatal(err)
	}

	assigned, err := s.Assign(ctx, e, bson.NewObjectID(), true)
	if err != nil {
		t.Fatal(err)
	}
	if !assigned.LocationVerified || assigned.EmployerID == nil {
		t.Fatalf("assigned = %+v", assigned)
	}
	// The returned entry must match what a later read decodes, or the response
	// would describe a state the database does not hold.
	stored, err := s.ByID(ctx, u.ID, e.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !stored.LocationVerified || *stored.EmployerID != *assigned.EmployerID {
		t.Fatalf("stored = %+v, want %+v", stored, assigned)
	}
}

func TestListIsScopedSortedAndWindowed(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	base := msTime(time.Now().UTC())

	// Three closed shifts an hour apart, plus a stranger's entry in the window.
	ats := []time.Time{base.Add(-3 * time.Hour), base.Add(-2 * time.Hour), base.Add(-time.Hour)}
	for i, at := range ats {
		f := testFix()
		f.At = at
		in, _, err := s.ClockIn(ctx, u, nil, fmt.Sprintf("c-%d", i), f)
		if err != nil {
			t.Fatal(err)
		}
		f.At = at.Add(30 * time.Minute)
		if _, err := s.ClockOut(ctx, u, in, fmt.Sprintf("close-%d", i), f); err != nil {
			t.Fatal(err)
		}
	}
	other := &user.User{ID: bson.NewObjectID(), DEKWrapped: u.DEKWrapped}
	stranger := testFix()
	stranger.At = ats[1]
	if _, _, err := s.ClockIn(ctx, other, nil, "c-0", stranger); err != nil {
		t.Fatal(err)
	}

	from, to := ats[1], ats[2]
	cases := []struct {
		name     string
		from, to *time.Time
		want     []time.Time
	}{
		{"unbounded, newest first", nil, nil, []time.Time{ats[2], ats[1], ats[0]}},
		{"from is inclusive", &from, nil, []time.Time{ats[2], ats[1]}},
		{"to is exclusive", nil, &to, []time.Time{ats[1], ats[0]}},
		{"half-open window", &from, &to, []time.Time{ats[1]}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := s.List(ctx, u.ID, tc.from, tc.to)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %d entries, want %d", len(got), len(tc.want))
			}
			for i, at := range tc.want {
				if !got[i].ClockIn.At.Equal(at) {
					t.Fatalf("entry %d at %s, want %s", i, got[i].ClockIn.At, at)
				}
			}
		})
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

func TestAddPingsSealsTheTrack(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	e, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil {
		t.Fatal(err)
	}
	if last, err := s.LastPing(ctx, e.ID); err != nil || last != nil {
		t.Fatalf("LastPing on a fresh entry = %+v, %v, want nil", last, err)
	}
	if n, err := s.AddPings(ctx, u, e.ID, nil); err != nil || n != 0 {
		t.Fatalf("AddPings(nil) = %d, %v, want 0", n, err)
	}

	base := msTime(time.Now().UTC())
	fixes := []Fix{
		{Lat: 13.7563, Lng: 100.5018, At: base},
		{Lat: 13.8888, Lng: 100.6666, At: base.Add(10 * time.Minute)},
	}
	n, err := s.AddPings(ctx, u, e.ID, fixes)
	if err != nil || n != len(fixes) {
		t.Fatalf("AddPings = %d, %v, want %d", n, err, len(fixes))
	}

	last, err := s.LastPing(ctx, e.ID)
	if err != nil || last == nil {
		t.Fatalf("LastPing = %+v, %v", last, err)
	}
	if !last.At.Equal(fixes[1].At) || last.EntryID != e.ID || last.UserID != u.ID {
		t.Fatalf("last ping = %+v, want the newest fix on this entry", last)
	}
	if bytes.Contains(last.LocEnc, []byte("13.88")) {
		t.Fatalf("ping location is not sealed: %q", last.LocEnc)
	}
	loc, err := s.openLoc(ctx, u, last.LocEnc)
	if err != nil || loc.Lat != fixes[1].Lat || loc.Lng != fixes[1].Lng {
		t.Fatalf("loc = %+v, %v", loc, err)
	}
	// created_at is the TTL anchor, not the ping time: a late flush keeps its
	// full 90 days.
	if last.CreatedAt.Before(base) {
		t.Fatalf("created_at = %s, want the write time", last.CreatedAt)
	}
}

func TestFlagIsIdempotent(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	e, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := s.Flag(ctx, e, flagSpeedAnomaly); err != nil {
			t.Fatal(err)
		}
	}
	stored, err := s.ByID(ctx, u.ID, e.ID)
	if err != nil || stored == nil {
		t.Fatalf("ByID = %+v, %v", stored, err)
	}
	if len(stored.Flags) != 1 || stored.Flags[0] != flagSpeedAnomaly {
		t.Fatalf("flags = %v, want [%s]", stored.Flags, flagSpeedAnomaly)
	}
}
