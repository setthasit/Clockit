package entry

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/setthasit/clockit/backend/internal/auth"
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

const (
	testAuth0Domain   = "test.auth0.local"
	testAuth0Audience = "https://api.clockit.test"
)

type testAPI struct {
	handler http.Handler
	key     *rsa.PrivateKey
	db      *mongo.Database
}

// newTestAPI wires the real route stack — httpx.NewEcho, the auth middleware
// against a local signing key, Mongo and Valkey — so these tests exercise the
// entry endpoints through the same middleware chain production uses. The user
// and employer routes are registered alongside because membership setup and the
// caller's user document come from them.
func newTestAPI(t *testing.T) *testAPI {
	t.Helper()
	addr := os.Getenv("VALKEY_ADDR")
	if addr == "" {
		t.Skip("VALKEY_ADDR not set")
	}
	db, env := testDB(t)

	vk, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{addr}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Auth0Domain:   testAuth0Domain,
		Auth0Audience: testAuth0Audience,
		MaxAccuracyM:  100,
		MaxClockSkew:  5 * time.Minute,
		AnchorRadiusM: 1000,
		// High enough that no test trips the limiter; the limiter itself is
		// covered in valkeyx.
		SpeedAnomalyKMH: 200,
		RateLimitPerMin: 1000,
	}
	authMW := auth.NewMiddlewareWithKeyfunc(cfg, func(*jwt.Token) (any, error) { return &key.PublicKey, nil })
	e := httpx.NewEcho(cfg)
	userStore := user.NewStore(db, env)
	employerStore := employer.NewStore(db, env)
	user.RegisterRoutes(e, user.NewHandler(userStore), authMW, vk, cfg)
	employer.RegisterRoutes(e, employer.NewHandler(employerStore), userStore, authMW, vk, cfg)
	RegisterRoutes(e, NewHandler(NewStore(db, env), employerStore, cfg), userStore, authMW, vk, cfg)
	return &testAPI{handler: e, key: key, db: db}
}

// token mints a verified identity; the subject is derived from the address so
// repeated calls for one address are the same person.
func (a *testAPI) token(t *testing.T, email string) string {
	return a.signedToken(t, email, true)
}

// unverifiedToken is the only way to reach a handler as someone whose
// invitation has not been claimed: a verified sign-in claims it on the spot.
func (a *testAPI) unverifiedToken(t *testing.T, email string) string {
	return a.signedToken(t, email, false)
}

func (a *testAPI) signedToken(t *testing.T, email string, verified bool) string {
	t.Helper()
	raw, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub":                            "auth0|" + email,
		"iss":                            "https://" + testAuth0Domain + "/",
		"aud":                            testAuth0Audience,
		"exp":                            time.Now().Add(time.Hour).Unix(),
		"https://clockit/email":          email,
		"https://clockit/email_verified": verified,
	}).SignedString(a.key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func (a *testAPI) do(method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, out any) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status = %d, want %d: %s", rec.Code, wantStatus, rec.Body)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
		t.Fatalf("%v (%s)", err, rec.Body)
	}
}

// assertErrorCode checks the envelope both frontends key their UX off, and
// hands back the details map so distance assertions read as one line.
func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode string) map[string]any {
	t.Helper()
	var body struct {
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	decodeBody(t, rec, wantStatus, &body)
	if body.Error.Code != wantCode {
		t.Fatalf("code = %q, want %q (%s)", body.Error.Code, wantCode, rec.Body)
	}
	return body.Error.Details
}

type entryJSON struct {
	ID               string  `json:"id"`
	ClientID         string  `json:"client_id"`
	EmployerID       *string `json:"employer_id"`
	Status           string  `json:"status"`
	LocationVerified bool    `json:"location_verified"`
}

func decodeEntry(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int) entryJSON {
	t.Helper()
	var body struct {
		Entry entryJSON `json:"entry"`
	}
	decodeBody(t, rec, wantStatus, &body)
	return body.Entry
}

// clockJSON builds a clock-in/clock-out body. Coordinates go through
// FormatFloat rather than a %f verb so a fixture derived from northOffset
// arrives at the server with the distance the test computed.
func clockJSON(clientID, employerID string, at time.Time, lat, lng float64) string {
	employerField := ""
	if employerID != "" {
		employerField = fmt.Sprintf("%q:%q,", "employer_id", employerID)
	}
	return fmt.Sprintf(`{%s"client_id":%q,"at":%q,"loc":{"lat":%s,"lng":%s,"accuracy":10},"mocked":false}`,
		employerField, clientID, at.Format(time.RFC3339Nano),
		strconv.FormatFloat(lat, 'f', -1, 64), strconv.FormatFloat(lng, 'f', -1, 64))
}

func (a *testAPI) clockIn(token, clientID, employerID string, at time.Time, lat, lng float64) *httptest.ResponseRecorder {
	return a.do(http.MethodPost, "/v1/entries/clock-in", token, clockJSON(clientID, employerID, at, lat, lng))
}

func (a *testAPI) clockOut(token, clientID string, at time.Time, lat, lng float64) *httptest.ResponseRecorder {
	return a.do(http.MethodPost, "/v1/entries/clock-out", token, clockJSON(clientID, "", at, lat, lng))
}

func (a *testAPI) createEmployer(t *testing.T, token string, anchor employer.LatLng) string {
	t.Helper()
	var body struct {
		Employer struct {
			ID string `json:"id"`
		} `json:"employer"`
	}
	decodeBody(t, a.do(http.MethodPost, "/v1/employers", token, fmt.Sprintf(
		`{"name":"Acme","anchor":{"lat":%s,"lng":%s},"timezone":"America/Vancouver"}`,
		strconv.FormatFloat(anchor.Lat, 'f', -1, 64), strconv.FormatFloat(anchor.Lng, 'f', -1, 64))),
		http.StatusCreated, &body)
	return body.Employer.ID
}

// activeMember signs the address in before the invitation is created, so the
// membership is claimed on add and the returned token can clock in right away.
func (a *testAPI) activeMember(t *testing.T, ownerToken, employerID, email string) string {
	t.Helper()
	token := a.token(t, email)
	if rec := a.do(http.MethodGet, "/v1/me", token, ""); rec.Code != http.StatusOK {
		t.Fatalf("sign in: status = %d: %s", rec.Code, rec.Body)
	}
	rec := a.do(http.MethodPost, "/v1/employers/"+employerID+"/members", ownerToken, `{"email":"`+email+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("add member: status = %d: %s", rec.Code, rec.Body)
	}
	return token
}

func (a *testAPI) storedEntry(t *testing.T, id string) Entry {
	t.Helper()
	oid, err := bson.ObjectIDFromHex(id)
	if err != nil {
		t.Fatal(err)
	}
	var e Entry
	if err := a.db.Collection("time_entries").FindOne(context.Background(), bson.M{"_id": oid}).Decode(&e); err != nil {
		t.Fatal(err)
	}
	return e
}

func (a *testAPI) countEntries(t *testing.T) int64 {
	t.Helper()
	n, err := a.db.Collection("time_entries").CountDocuments(context.Background(), bson.M{})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// The mobile outbox replays a clock-in until it is acknowledged: every replay
// must answer with the original entry, and the location rules must not run a
// second time — by the time a backlog flushes, the fix is old and far away.
func TestClockInReplayReturnsTheOriginalEntry(t *testing.T) {
	api := newTestAPI(t)
	token := api.token(t, "solo@example.com")
	at := time.Now().UTC().Add(-time.Minute)

	first := api.clockIn(token, "c-1", "", at, vanLat, vanLng)
	if first.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", first.Code, first.Body)
	}
	replay := api.clockIn(token, "c-1", "", at, vanLat, vanLng)
	if replay.Code != http.StatusOK {
		t.Fatalf("replay status = %d, want 200: %s", replay.Code, replay.Body)
	}
	if replay.Body.String() != first.Body.String() {
		t.Fatalf("replay body = %s, want the original %s", replay.Body, first.Body)
	}

	stale := api.clockIn(token, "c-1", "", time.Now().UTC().Add(-time.Hour), vanLat+northOffset(50_000), vanLng)
	if stale.Code != http.StatusOK || stale.Body.String() != first.Body.String() {
		t.Fatalf("stale replay = %d %s, want the original entry", stale.Code, stale.Body)
	}
	if n := api.countEntries(t); n != 1 {
		t.Fatalf("stored %d entries, want 1", n)
	}
}

// A different client_id while a shift is running is a second clock-in, not a
// replay: the app forgot to clock out, and the conflict is what tells it so.
func TestSecondClockInWhileOpenIsRejected(t *testing.T) {
	api := newTestAPI(t)
	token := api.token(t, "double@example.com")
	now := time.Now().UTC()

	if rec := api.clockIn(token, "c-1", "", now.Add(-time.Minute), vanLat, vanLng); rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
	}
	assertErrorCode(t, api.clockIn(token, "c-2", "", now, vanLat, vanLng), http.StatusConflict, "OPEN_ENTRY_EXISTS")
	if n := api.countEntries(t); n != 1 {
		t.Fatalf("stored %d entries, want 1", n)
	}
}

// The distance is in the error so the app can say how far off the employee is
// rather than a bare "too far".
func TestEmployerClockInOutOfRangeReportsTheDistance(t *testing.T) {
	api := newTestAPI(t)
	owner := api.token(t, "owner@example.com")
	employerID := api.createEmployer(t, owner, employer.LatLng{Lat: vanLat, Lng: vanLng})
	worker := api.activeMember(t, owner, employerID, "late@example.com")

	rec := api.clockIn(worker, "c-1", employerID, time.Now().UTC(), vanLat+northOffset(1800), vanLng)
	details := assertErrorCode(t, rec, http.StatusUnprocessableEntity, "OUT_OF_RANGE")
	if details["distance_m"] != float64(1800) || details["limit_m"] != float64(1000) {
		t.Fatalf("details = %v, want distance_m 1800 and limit_m 1000", details)
	}
	if n := api.countEntries(t); n != 0 {
		t.Fatalf("stored %d entries, want none", n)
	}

	// Inside the zone is the control: the rejection was about distance alone.
	inRange := api.clockIn(worker, "c-2", employerID, time.Now().UTC(), vanLat+northOffset(900), vanLng)
	got := decodeEntry(t, inRange, http.StatusCreated)
	if got.EmployerID == nil || *got.EmployerID != employerID || !got.LocationVerified {
		t.Fatalf("entry = %+v, want a verified entry for %s", got, employerID)
	}
}

// An invitation binds an address, not a person: until a verified sign-in claims
// it, the holder is no more entitled to the employer's zone than a stranger.
func TestClockInRequiresAnActiveMembership(t *testing.T) {
	api := newTestAPI(t)
	owner := api.token(t, "boss@example.com")
	employerID := api.createEmployer(t, owner, employer.LatLng{Lat: vanLat, Lng: vanLng})

	const invited = "invited@example.com"
	if rec := api.do(http.MethodPost, "/v1/employers/"+employerID+"/members", owner,
		`{"email":"`+invited+`"}`); rec.Code != http.StatusCreated {
		t.Fatalf("add member: status = %d: %s", rec.Code, rec.Body)
	}

	now := time.Now().UTC()
	cases := []struct{ name, token string }{
		{"invited but unclaimed", api.unverifiedToken(t, invited)},
		{"never invited", api.token(t, "stranger@example.com")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assertErrorCode(t, api.clockIn(tc.token, "c-1", employerID, now, vanLat, vanLng),
				http.StatusForbidden, "NOT_MEMBER")
		})
	}
	if n := api.countEntries(t); n != 0 {
		t.Fatalf("stored %d entries, want none", n)
	}
}

// A personal shift is its own anchor (design §4.5): closing it a couple of
// kilometres away is the same rejection an employer zone would give.
func TestPersonalClockOutBeyondTheStartIsRejected(t *testing.T) {
	api := newTestAPI(t)
	token := api.token(t, "roamer@example.com")
	opened := decodeEntry(t, api.clockIn(token, "c-1", "", time.Now().UTC().Add(-2*time.Minute), vanLat, vanLng),
		http.StatusCreated)

	rec := api.clockOut(token, "close-1", time.Now().UTC(), vanLat+northOffset(1800), vanLng)
	details := assertErrorCode(t, rec, http.StatusUnprocessableEntity, "OUT_OF_RANGE")
	if details["distance_m"] != float64(1800) || details["limit_m"] != float64(1000) {
		t.Fatalf("details = %v, want distance_m 1800 and limit_m 1000", details)
	}
	if stored := api.storedEntry(t, opened.ID); stored.Status != statusOpen || stored.ClockOut != nil {
		t.Fatalf("stored = %+v, want the shift still open", stored)
	}

	// Back within the radius it closes, so nothing but position was wrong.
	closed := decodeEntry(t, api.clockOut(token, "close-1", time.Now().UTC(), vanLat+northOffset(900), vanLng),
		http.StatusOK)
	if closed.ID != opened.ID || closed.Status != statusClosed {
		t.Fatalf("entry = %+v, want %s closed", closed, opened.ID)
	}
}

func TestClockOutWithoutAnOpenShift(t *testing.T) {
	api := newTestAPI(t)
	token := api.token(t, "idle@example.com")
	assertErrorCode(t, api.clockOut(token, "close-1", time.Now().UTC(), vanLat, vanLng),
		http.StatusConflict, "NO_OPEN_ENTRY")
}

// Same contract as the clock-in replay, on the close half: the acknowledgement
// can be lost, so the outbox re-sends a close whose fix is by then stale and
// far away, and the server must still answer with the entry it already closed.
func TestClockOutReplaySkipsTheLocationRules(t *testing.T) {
	api := newTestAPI(t)
	token := api.token(t, "replay@example.com")
	if rec := api.clockIn(token, "c-1", "", time.Now().UTC().Add(-2*time.Minute), vanLat, vanLng); rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
	}

	at := time.Now().UTC()
	first := api.clockOut(token, "close-1", at, vanLat, vanLng)
	if first.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", first.Code, first.Body)
	}
	replay := api.clockOut(token, "close-1", at, vanLat, vanLng)
	if replay.Code != http.StatusOK || replay.Body.String() != first.Body.String() {
		t.Fatalf("replay = %d %s, want the original %s", replay.Code, replay.Body, first.Body)
	}
	stale := api.clockOut(token, "close-1", at.Add(-time.Hour), vanLat+northOffset(50_000), vanLng)
	if stale.Code != http.StatusOK || stale.Body.String() != first.Body.String() {
		t.Fatalf("stale replay = %d %s, want the original entry", stale.Code, stale.Body)
	}
}

// closeRace fires two clock-outs at one open shift at the same instant, which
// is what makes the store's status guard fail for the loser and sends the
// handler down its post-ErrEntryNotOpen branch.
func (a *testAPI) closeRace(token, clientA, clientB string, at time.Time) [2]*httptest.ResponseRecorder {
	var recs [2]*httptest.ResponseRecorder
	ids := [2]string{clientA, clientB}
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range recs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			recs[i] = a.clockOut(token, ids[i], at, vanLat, vanLng)
		}()
	}
	close(start)
	wg.Wait()
	return recs
}

// closeRaceRounds is how many shifts each race test burns. A single round
// usually serialises, and the loser then simply finds no open entry; the
// handler's post-ErrEntryNotOpen branch only runs when the two requests
// genuinely overlap, which takes a run of rounds to hit. The assertions hold
// either way — the repetition buys branch coverage, not correctness.
const closeRaceRounds = 30

// Two parallel flushes of the same close: whichever loses the write must still
// recognise its own close through close_client_id and answer with the entry,
// never a conflict.
func TestConcurrentClockOutWithOneClientIDBothReplay(t *testing.T) {
	api := newTestAPI(t)
	token := api.token(t, "racer@example.com")

	for i := range closeRaceRounds {
		at := time.Now().UTC()
		if rec := api.clockIn(token, fmt.Sprintf("c-%d", i), "", at.Add(-time.Minute), vanLat, vanLng); rec.Code != http.StatusCreated {
			t.Fatalf("round %d: status = %d, want 201: %s", i, rec.Code, rec.Body)
		}
		clientID := fmt.Sprintf("close-%d", i)
		recs := api.closeRace(token, clientID, clientID, at)
		for j, rec := range recs {
			if rec.Code != http.StatusOK {
				t.Fatalf("round %d call %d: status = %d, want 200: %s", i, j, rec.Code, rec.Body)
			}
		}
		if recs[0].Body.String() != recs[1].Body.String() {
			t.Fatalf("round %d bodies differ:\n%s\n%s", i, recs[0].Body, recs[1].Body)
		}
		if stored := api.storedEntry(t, decodeEntry(t, recs[0], http.StatusOK).ID); stored.CloseClientID != clientID {
			t.Fatalf("round %d stored = %+v, want close_client_id %s", i, stored, clientID)
		}
	}
}

// Two different closes racing for one shift is not a replay: exactly one wins
// and the other is told the shift is gone.
func TestConcurrentClockOutWithTwoClientIDsHasOneWinner(t *testing.T) {
	api := newTestAPI(t)
	token := api.token(t, "contender@example.com")

	for i := range closeRaceRounds {
		at := time.Now().UTC()
		if rec := api.clockIn(token, fmt.Sprintf("c-%d", i), "", at.Add(-time.Minute), vanLat, vanLng); rec.Code != http.StatusCreated {
			t.Fatalf("round %d: status = %d, want 201: %s", i, rec.Code, rec.Body)
		}
		closed, conflicts := 0, 0
		for j, rec := range api.closeRace(token, fmt.Sprintf("a-%d", i), fmt.Sprintf("b-%d", i), at) {
			switch rec.Code {
			case http.StatusOK:
				closed++
			case http.StatusConflict:
				assertErrorCode(t, rec, http.StatusConflict, "NO_OPEN_ENTRY")
				conflicts++
			default:
				t.Fatalf("round %d call %d: status = %d: %s", i, j, rec.Code, rec.Body)
			}
		}
		if closed != 1 || conflicts != 1 {
			t.Fatalf("round %d: %d closed and %d conflicted, want one of each", i, closed, conflicts)
		}
	}
	if n := api.countEntries(t); n != closeRaceRounds {
		t.Fatalf("stored %d entries, want %d", n, closeRaceRounds)
	}
}

// Assigning never rejects (design §4.5.5): a shift worked outside the zone is
// still a real shift, it is just recorded unverified for the employer to judge.
func TestAssignRecordsTheDistanceVerdict(t *testing.T) {
	api := newTestAPI(t)
	owner := api.token(t, "cafe@example.com")
	employerID := api.createEmployer(t, owner, employer.LatLng{Lat: vanLat, Lng: vanLng})
	worker := api.activeMember(t, owner, employerID, "shifty@example.com")

	// shift records a closed personal shift whose two fixes sit metres north of
	// the employer's anchor.
	now := time.Now().UTC()
	shift := func(n int, metresNorth float64, in, out time.Duration) string {
		t.Helper()
		lat := vanLat + northOffset(metresNorth)
		opened := decodeEntry(t, api.clockIn(worker, fmt.Sprintf("c-%d", n), "", now.Add(in), lat, vanLng),
			http.StatusCreated)
		decodeEntry(t, api.clockOut(worker, fmt.Sprintf("close-%d", n), now.Add(out), lat, vanLng), http.StatusOK)
		return opened.ID
	}
	nearID := shift(1, 900, -3*time.Minute, -2*time.Minute)
	farID := shift(2, 1800, -90*time.Second, -30*time.Second)

	cases := []struct {
		name string
		id   string
		want bool
	}{
		{"inside the zone", nearID, true},
		{"outside the zone", farID, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeEntry(t, api.do(http.MethodPatch, "/v1/entries/"+tc.id, worker,
				`{"employer_id":"`+employerID+`"}`), http.StatusOK)
			if got.EmployerID == nil || *got.EmployerID != employerID {
				t.Fatalf("entry = %+v, want employer %s", got, employerID)
			}
			if got.LocationVerified != tc.want {
				t.Fatalf("location_verified = %v, want %v", got.LocationVerified, tc.want)
			}
			stored := api.storedEntry(t, tc.id)
			if stored.EmployerID == nil || stored.EmployerID.Hex() != employerID || stored.LocationVerified != tc.want {
				t.Fatalf("stored = %+v, want employer %s and location_verified %v", stored, employerID, tc.want)
			}
		})
	}
}
