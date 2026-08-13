package entry

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/httpx"
	"github.com/setthasit/clockit/backend/internal/user"
)

// Assigning an open entry would re-point its clock-out at the employer's
// anchor, locking a personal shift started out of zone out of ever closing.
// The guard runs before any employer lookup, so a nil employer store also
// proves the request is rejected without one.
func TestAssignRejectsOpenEntry(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	open, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil {
		t.Fatal(err)
	}

	e := echo.New()
	e.HTTPErrorHandler = httpx.ErrorHandler
	body := `{"employer_id":"` + bson.NewObjectID().Hex() + `"}`
	req := httptest.NewRequest(http.MethodPatch, "/v1/entries/"+open.ID.Hex(), strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(open.ID.Hex())
	// The user middleware's key: a mismatch panics in CurrentUser rather than
	// passing quietly.
	c.Set("clockit.user", u)

	if err := NewHandler(s, nil, config.Config{}).Assign(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "INVALID_ARGUMENT") {
		t.Fatalf("status = %d, body = %s, want 400 INVALID_ARGUMENT", rec.Code, rec.Body)
	}

	stored, err := s.ByID(ctx, u.ID, open.ID)
	if err != nil || stored == nil {
		t.Fatalf("ByID = %+v, %v", stored, err)
	}
	if stored.EmployerID != nil || stored.Status != statusOpen {
		t.Fatalf("stored = %+v, want the untouched open personal entry", stored)
	}
}

// postPings drives the endpoint the way the router does, minus the middleware:
// the user is already resolved by the time a handler runs.
func postPings(t *testing.T, h *Handler, u *user.User, body string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	e.HTTPErrorHandler = httpx.ErrorHandler
	req := httptest.NewRequest(http.MethodPost, "/v1/pings", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("clockit.user", u)
	if err := h.Pings(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

func pingJSON(at time.Time, lat, lng float64) string {
	return fmt.Sprintf(`{"at":%q,"loc":{"lat":%f,"lng":%f,"accuracy":12}}`, at.Format(time.RFC3339Nano), lat, lng)
}

// The shift can close between a ping being captured and the outbox flushing it.
// Erroring would strand the batch in the client's queue forever, so the server
// accepts the request and drops the breadcrumbs.
func TestPingsWithoutOpenEntryAreDropped(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	h := NewHandler(s, nil, config.Config{SpeedAnomalyKMH: 200})

	body := `{"pings":[` + pingJSON(time.Now().UTC(), vanLat, vanLng) + `]}`
	rec := postPings(t, h, u, body)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accepted":0`) {
		t.Fatalf("status = %d, body = %s, want 200 accepted:0", rec.Code, rec.Body)
	}
	n, err := s.pings.CountDocuments(ctx, bson.M{"user_id": u.ID})
	if err != nil || n != 0 {
		t.Fatalf("stored %d pings, want 0 (%v)", n, err)
	}
}

func TestPingsFlagImpossibleSpeed(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	h := NewHandler(s, nil, config.Config{SpeedAnomalyKMH: 200})

	base := msTime(time.Now().UTC().Add(-time.Hour))
	in := Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: base}
	open, _, err := s.ClockIn(ctx, u, nil, "c-1", in)
	if err != nil {
		t.Fatal(err)
	}

	// A 5 km walk-and-bus over ten minutes: fast, not impossible.
	body := `{"pings":[` + pingJSON(base.Add(10*time.Minute), vanLat+northOffset(5000), vanLng) + `]}`
	if rec := postPings(t, h, u, body); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accepted":1`) {
		t.Fatalf("status = %d, body = %s, want 200 accepted:1", rec.Code, rec.Body)
	}
	stored, err := s.ByID(ctx, u.ID, open.ID)
	if err != nil || len(stored.Flags) != 0 {
		t.Fatalf("flags = %v, %v, want none yet", stored.Flags, err)
	}

	// Next flush lands 300 km away ten minutes later. The jump is across the
	// seam between the stored ping and the new batch, which still counts.
	body = `{"pings":[` +
		pingJSON(base.Add(30*time.Minute), vanLat+northOffset(305_000), vanLng) + `,` +
		pingJSON(base.Add(20*time.Minute), vanLat+northOffset(300_000), vanLng) + `]}`
	if rec := postPings(t, h, u, body); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"accepted":2`) {
		t.Fatalf("status = %d, body = %s, want 200 accepted:2", rec.Code, rec.Body)
	}

	stored, err = s.ByID(ctx, u.ID, open.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.Flags) != 1 || stored.Flags[0] != flagSpeedAnomaly {
		t.Fatalf("flags = %v, want [%s]", stored.Flags, flagSpeedAnomaly)
	}
	// Flagged, never rejected: the breadcrumbs are still evidence (design §4.5).
	n, err := s.pings.CountDocuments(ctx, bson.M{"entry_id": open.ID})
	if err != nil || n != 3 {
		t.Fatalf("stored %d pings, want 3 (%v)", n, err)
	}
}

func TestPingFixesValidatesAndOrdersTheBatch(t *testing.T) {
	now := msTime(time.Now().UTC())
	loc := &locBody{Lat: ptr(vanLat), Lng: ptr(vanLng)}

	oversized := make([]pingBody, maxPingBatch+1)
	for i := range oversized {
		oversized[i] = pingBody{At: now, Loc: loc}
	}
	if _, err := pingFixes(oversized); err == nil {
		t.Fatalf("pingFixes(%d pings) = nil error, want the batch cap to reject it", len(oversized))
	}
	if _, err := pingFixes([]pingBody{{Loc: loc}}); err == nil {
		t.Fatal("a ping without at was accepted")
	}
	if _, err := pingFixes([]pingBody{{At: now}}); err == nil {
		t.Fatal("a ping without loc was accepted")
	}

	// The outbox flushes whatever it queued: order is the server's job.
	out, err := pingFixes([]pingBody{
		{At: now.Add(time.Minute), Loc: loc},
		{At: now, Loc: loc},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !out[0].At.Equal(now) || !out[1].At.Equal(now.Add(time.Minute)) {
		t.Fatalf("fixes = %v, want ascending by at", out)
	}
}

func ptr[T any](v T) *T { return &v }

// getEmployerEntries drives the endpoint the way the router does, minus the
// middleware: the caller is already resolved by the time a handler runs.
func getEmployerEntries(t *testing.T, h *Handler, caller *user.User, employerID bson.ObjectID) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	e.HTTPErrorHandler = httpx.ErrorHandler
	req := httptest.NewRequest(http.MethodGet, "/v1/employers/"+employerID.Hex()+"/entries", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(employerID.Hex())
	c.Set("clockit.user", caller)
	if err := h.EmployerList(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

// The employer view is the one place a shift is read by someone other than its
// owner, so it is the one place a leaked coordinate would matter.
func TestEmployerListJoinsMembersAndHidesCoordinates(t *testing.T) {
	ctx := context.Background()
	s, worker := testStore(t)
	db := s.entries.Database()
	worker.Name, worker.Email = "Dana Lee", "dana@example.com"
	if _, err := db.Collection("users").InsertOne(ctx, worker); err != nil {
		t.Fatal(err)
	}

	employers := employer.NewStore(db, s.env)
	owner := bson.NewObjectID()
	emp, err := employers.Create(ctx, owner, "Cafe", "Asia/Bangkok", employer.LatLng{Lat: vanLat, Lng: vanLng})
	if err != nil {
		t.Fatal(err)
	}

	in := msTime(time.Now().UTC().Add(-3 * time.Hour))
	open, _, err := s.ClockIn(ctx, worker, &emp.ID, "c-1", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: in})
	if err != nil {
		t.Fatal(err)
	}
	// 90 minutes and 20 seconds: duration_minutes rounds to the nearest minute.
	out := in.Add(90*time.Minute + 20*time.Second)
	if _, err := s.ClockOut(ctx, worker, open, "c-2", Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: out}); err != nil {
		t.Fatal(err)
	}

	h := NewHandler(s, employers, config.Config{})
	rec := getEmployerEntries(t, h, &user.User{ID: owner}, emp.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s, want 200", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	for _, want := range []string{`"Dana Lee"`, `"dana@example.com"`, `"duration_minutes":90`, `"location_verified":true`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body = %s, want it to contain %s", body, want)
		}
	}
	// The security assert: no coordinates, and no fix metadata either.
	for _, leak := range []string{`"lat"`, `"lng"`, `"loc"`, `"accuracy"`, `"mocked"`} {
		if strings.Contains(body, leak) {
			t.Fatalf("body = %s, leaked %q to the employer", body, leak)
		}
	}

	// A stranger must not learn that the employer exists.
	rec = getEmployerEntries(t, h, &user.User{ID: bson.NewObjectID()}, emp.ID)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s, want 404 for a non-owner", rec.Code, rec.Body)
	}
}
