package tip

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/entry"
	"github.com/setthasit/clockit/backend/internal/httpx"
	"github.com/setthasit/clockit/backend/internal/mongox"
	"github.com/setthasit/clockit/backend/internal/user"
)

// testDB is a throwaway database and its envelope, shared by the handler-level
// tests and the full route-stack harness below.
func testDB(t *testing.T) (*mongo.Database, *crypto.Envelope) {
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
	// The upsert guarantee is index behaviour: without the unique index a second
	// PUT could quietly insert a second row for the same day.
	if err := mongox.EnsureIndexes(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return db, env
}

// testHandler wires the real stores against a throwaway database, and returns
// the owner the handlers will see plus their employer.
func testHandler(t *testing.T) (*Handler, *user.User, *employer.Employer) {
	t.Helper()
	db, env := testDB(t)

	owner := &user.User{ID: bson.NewObjectID()}
	employers := employer.NewStore(db, env)
	e, err := employers.Create(context.Background(), owner.ID, "Acme", "America/Vancouver",
		employer.LatLng{Lat: 49.2827, Lng: -123.1207})
	if err != nil {
		t.Fatal(err)
	}
	return NewHandler(NewStore(db), employers, nil), owner, e
}

// call drives a handler the way the router does, minus the middleware: the user
// is already resolved and the employer id is already a path parameter.
func call(t *testing.T, h echo.HandlerFunc, u *user.User, method, target, body string, params map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	e.HTTPErrorHandler = httpx.ErrorHandler
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	names, values := make([]string, 0, len(params)), make([]string, 0, len(params))
	for name, value := range params {
		names, values = append(names, name), append(values, value)
	}
	c.SetParamNames(names...)
	c.SetParamValues(values...)
	c.Set("clockit.user", u)
	if err := h(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	return rec
}

func (h *Handler) put(t *testing.T, u *user.User, employerID bson.ObjectID, date, body string) *httptest.ResponseRecorder {
	t.Helper()
	return call(t, h.Put, u, http.MethodPut, "/v1/employers/"+employerID.Hex()+"/tips/"+date, body,
		map[string]string{"id": employerID.Hex(), "date": date})
}

func (h *Handler) list(t *testing.T, u *user.User, employerID bson.ObjectID, query string) []view {
	t.Helper()
	rec := call(t, h.List, u, http.MethodGet, "/v1/employers/"+employerID.Hex()+"/tips?"+query, "",
		map[string]string{"id": employerID.Hex()})
	if rec.Code != http.StatusOK {
		t.Fatalf("list: status = %d, want 200: %s", rec.Code, rec.Body)
	}
	var body struct {
		Tips []view `json:"tips"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("%v (%s)", err, rec.Body)
	}
	return body.Tips
}

// A day's tip is edited over and over from the table UI: every PUT must land on
// the one row the unique index allows, and zero must clear rather than be
// mistaken for "no amount sent".
func TestPutUpsertsAndListsByDay(t *testing.T) {
	h, owner, e := testHandler(t)

	if rec := h.put(t, owner, e.ID, "2026-03-14", `{"amount_cents":12345}`); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
	}
	if rec := h.put(t, owner, e.ID, "2026-03-14", `{"amount_cents":500}`); rec.Code != http.StatusOK {
		t.Fatalf("overwrite: status = %d, want 200: %s", rec.Code, rec.Body)
	}
	if rec := h.put(t, owner, e.ID, "2026-03-13", `{"amount_cents":0}`); rec.Code != http.StatusOK {
		t.Fatalf("zero: status = %d, want 200: %s", rec.Code, rec.Body)
	}

	want := []view{{Date: "2026-03-13", AmountCents: 0}, {Date: "2026-03-14", AmountCents: 500}}
	if got := h.list(t, owner, e.ID, ""); len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("tips = %+v, want %+v", got, want)
	}
	// Inclusive bounds: a report through the 14th must carry the 14th's tip.
	if got := h.list(t, owner, e.ID, "from=2026-03-14&to=2026-03-14"); len(got) != 1 || got[0] != want[1] {
		t.Fatalf("windowed tips = %+v, want just %+v", got, want[1])
	}
}

func TestPutRejectsBadInput(t *testing.T) {
	h, owner, e := testHandler(t)
	cases := []struct{ name, date, body string }{
		{"missing amount", "2026-03-14", `{}`},
		{"negative amount", "2026-03-14", `{"amount_cents":-1}`},
		{"implausible amount", "2026-03-14", `{"amount_cents":100000001}`},
		{"not a date", "march", `{"amount_cents":100}`},
		{"unpadded date", "2026-3-4", `{"amount_cents":100}`},
		{"impossible date", "2026-02-30", `{"amount_cents":100}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.put(t, owner, e.ID, tc.date, tc.body)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "INVALID_ARGUMENT") {
				t.Fatalf("status = %d, body = %s, want 400 INVALID_ARGUMENT", rec.Code, rec.Body)
			}
		})
	}
	if got := h.list(t, owner, e.ID, ""); len(got) != 0 {
		t.Fatalf("rejected writes stored %+v", got)
	}
}

func shift(userID bson.ObjectID, in, out time.Time) entry.Entry {
	return entry.Entry{
		UserID:   userID,
		ClockIn:  entry.ClockPoint{At: in.UTC()},
		ClockOut: &entry.ClockPoint{At: out.UTC()},
	}
}

// The money math in one pass: a shift attributed to the local day it started on
// even though it ends after midnight (design §4.6), half-up cent rounding on
// base pay, a missing rate leaving base pay unknown rather than zero, and a
// split that still sums to the whole pool.
func TestBuildReportMidnightSpanRoundingAndSplit(t *testing.T) {
	loc, err := time.LoadLocation("America/Vancouver")
	if err != nil {
		t.Fatal(err)
	}
	ana, bo := bson.NewObjectID(), bson.NewObjectID()
	rate := int64(1875)
	members := []employer.Member{
		{UserID: &ana, Name: "Ana", Email: "ana@example.com", HourlyRateCents: &rate},
		{UserID: &bo, Name: "Bo", Email: "bo@example.com"},
	}
	local := func(h, m int, day int) time.Time { return time.Date(2026, 1, day, h, m, 0, 0, loc) }
	entries := []entry.Entry{
		// 242 minutes across midnight: 1875¢/h lands on exactly half a cent.
		shift(ana, local(22, 0, 14), local(2, 2, 15)),
		shift(bo, local(9, 0, 14), local(11, 0, 14)),
	}

	days := buildReport(entries, members, []Tip{{Date: "2026-01-14", AmountCents: 100}}, loc, "", "")
	if len(days) != 1 || days[0].Date != "2026-01-14" {
		t.Fatalf("days = %+v, want one day 2026-01-14", days)
	}
	day := days[0]
	if day.TotalMinutes != 362 || day.TotalBasePayCents != 7563 || day.TotalTipShareCents != 100 || day.TotalCents != 7663 {
		t.Fatalf("day totals = %+v", day)
	}

	anaRow, boRow := day.Rows[0], day.Rows[1]
	if anaRow.User.Name != "Ana" || anaRow.Minutes != 242 || anaRow.BasePayCents == nil || *anaRow.BasePayCents != 7563 {
		t.Fatalf("ana = %+v, want 242 min and 7563¢ base pay", anaRow)
	}
	if anaRow.TipShareCents != 67 || anaRow.TotalCents != 7630 {
		t.Fatalf("ana = %+v, want 67¢ of the tip", anaRow)
	}
	if boRow.HourlyRateCents != nil || boRow.BasePayCents != nil {
		t.Fatalf("bo = %+v, want an unknown rate and unknown base pay", boRow)
	}
	if boRow.Minutes != 120 || boRow.TipShareCents != 33 || boRow.TotalCents != 33 {
		t.Fatalf("bo = %+v, want the tip share alone", boRow)
	}
}

// A tip typed on the wrong date lands on a day nobody worked. It has to stay
// visible — an invisible $500 is one the employer can never correct. The same
// pass checks the day bounds bind here rather than in the entry query: the
// slack window admits the tail of the previous day, and the report must not.
func TestBuildReportSurfacesOrphanTipsAndBoundsDays(t *testing.T) {
	loc, err := time.LoadLocation("America/Vancouver")
	if err != nil {
		t.Fatal(err)
	}
	ana := bson.NewObjectID()
	members := []employer.Member{{UserID: &ana, Name: "Ana", Email: "ana@example.com"}}
	local := func(day, h, m int) time.Time { return time.Date(2026, 1, day, h, m, 0, 0, loc) }
	entries := []entry.Entry{
		shift(ana, local(13, 23, 30), local(14, 1, 0)), // belongs to the 13th, out of range
		shift(ana, local(14, 9, 0), local(14, 11, 0)),
	}
	tips := []Tip{{Date: "2026-01-14", AmountCents: 1000}, {Date: "2026-01-15", AmountCents: 50000}}

	days := buildReport(entries, members, tips, loc, "2026-01-14", "2026-01-15")
	if len(days) != 2 {
		t.Fatalf("days = %+v, want the 14th and the orphaned 15th only", days)
	}
	if worked := days[0]; worked.Date != "2026-01-14" || worked.TotalMinutes != 120 || len(worked.Rows) != 1 {
		t.Fatalf("worked day = %+v, want 120 minutes from the in-range shift alone", worked)
	}
	orphan := days[1]
	if orphan.Date != "2026-01-15" || orphan.TipCents != 50000 || len(orphan.Rows) != 0 {
		t.Fatalf("orphan day = %+v, want the tip visible with no shares", orphan)
	}
	if orphan.TotalTipShareCents != 0 || orphan.TotalMinutes != 0 || orphan.TotalCents != 0 {
		t.Fatalf("orphan day = %+v, want nothing assigned", orphan)
	}
	// The table iterates rows: an empty day must serialise [] and not null.
	body, err := json.Marshal(orphan)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"rows":[]`) {
		t.Fatalf("orphan day json = %s, want empty rows array", body)
	}
}

// Zones that spring forward at midnight (Chile) have days whose local midnight
// does not exist; time normalises those backwards an hour. A window built tight
// on such a day would end before its last hour, so a 23:00 shift would silently
// go unpaid. instantWindow keeps a day of slack on both sides instead.
func TestInstantWindowCoversMidnightGapDay(t *testing.T) {
	loc, err := time.LoadLocation("America/Santiago")
	if err != nil {
		t.Skip("tzdata for America/Santiago unavailable")
	}
	var gap time.Time
	for d := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC); d.Year() < 2028; d = d.AddDate(0, 0, 1) {
		day := d.Format(dayLayout)
		at, err := time.ParseInLocation(dayLayout, day, loc)
		if err != nil {
			t.Fatal(err)
		}
		if at.Format(dayLayout) != day {
			gap = d
			break
		}
	}
	if gap.IsZero() {
		t.Skip("no midnight-gap day in this tzdata")
	}

	from, to, err := instantWindow(gap.Format(dayLayout), gap.Format(dayLayout), loc)
	if err != nil {
		t.Fatal(err)
	}
	// The store filters [from, to) on clock_in.at.
	first := time.Date(gap.Year(), gap.Month(), gap.Day(), 1, 0, 0, 0, loc)
	last := time.Date(gap.Year(), gap.Month(), gap.Day(), 23, 0, 0, 0, loc)
	if first.Before(*from) {
		t.Fatalf("window starts at %s, after the day's first shift %s", from, first)
	}
	if !last.Before(*to) {
		t.Fatalf("window ends at %s, dropping the 23:00 shift at %s", to, last)
	}
	// The from end carries the same day of slack, so no offset change tzdata can
	// ship moves a requested day's first shift out of the window. Shrinking the
	// slack back to an hour fails here.
	midnight := time.Date(gap.Year(), gap.Month(), gap.Day(), 0, 0, 0, 0, loc)
	if from.After(midnight.Add(-24 * time.Hour)) {
		t.Fatalf("window starts at %s, less than a day before local midnight %s", from, midnight)
	}
}

// Ownership failures answer 404 on every route here, so the endpoints never
// confirm which employer ids exist.
func TestTipRoutesAre404ForNonOwners(t *testing.T) {
	h, _, e := testHandler(t)
	stranger := &user.User{ID: bson.NewObjectID()}

	handlers := map[string]echo.HandlerFunc{"list": h.List, "report": h.Report}
	for name, handler := range handlers {
		t.Run(name, func(t *testing.T) {
			rec := call(t, handler, stranger, http.MethodGet, "/v1/employers/"+e.ID.Hex()+"/x", "",
				map[string]string{"id": e.ID.Hex()})
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404: %s", rec.Code, rec.Body)
			}
		})
	}
	rec := h.put(t, stranger, e.ID, "2026-03-14", `{"amount_cents":100}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("put: status = %d, want 404: %s", rec.Code, rec.Body)
	}
}

const (
	testAuth0Domain   = "test.auth0.local"
	testAuth0Audience = "https://api.clockit.test"
	// The employer's anchor, downtown Vancouver. Every fixture shift is clocked
	// on it, so distance never enters the report.
	vanLat, vanLng = 49.2827, -123.1207
)

// testAPI wires the real route stack — httpx.NewEcho, the auth middleware
// against a local signing key, Mongo and Valkey — so the report is read exactly
// the way a client reads it. The user, employer and entry routes are registered
// alongside because the fixture's people, memberships and rates come from them.
type testAPI struct {
	handler http.Handler
	key     *rsa.PrivateKey
	db      *mongo.Database
	entries *entry.Store
}

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
		RateLimitPerMin: 1000,
	}
	authMW := auth.NewMiddlewareWithKeyfunc(cfg, func(*jwt.Token) (any, error) { return &key.PublicKey, nil })
	e := httpx.NewEcho(cfg)
	userStore := user.NewStore(db, env)
	employerStore := employer.NewStore(db, env)
	entryStore := entry.NewStore(db, env)
	user.RegisterRoutes(e, user.NewHandler(userStore), authMW, vk, cfg)
	employer.RegisterRoutes(e, employer.NewHandler(employerStore), userStore, authMW, vk, cfg)
	entry.RegisterRoutes(e, entry.NewHandler(entryStore, employerStore, cfg), userStore, authMW, vk, cfg)
	RegisterRoutes(e, NewHandler(NewStore(db), employerStore, entryStore), userStore, authMW, vk, cfg)
	return &testAPI{handler: e, key: key, db: db, entries: entryStore}
}

// token mints a verified identity; the subject is derived from the address so
// repeated calls for one address are the same person.
func (a *testAPI) token(t *testing.T, email string) string {
	t.Helper()
	raw, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub":                            "auth0|" + email,
		"iss":                            "https://" + testAuth0Domain + "/",
		"aud":                            testAuth0Audience,
		"exp":                            time.Now().Add(time.Hour).Unix(),
		"https://clockit/email":          email,
		"https://clockit/email_verified": true,
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

func (a *testAPI) createEmployer(t *testing.T, ownerToken string) string {
	t.Helper()
	var body struct {
		Employer struct {
			ID string `json:"id"`
		} `json:"employer"`
	}
	decodeBody(t, a.do(http.MethodPost, "/v1/employers", ownerToken, fmt.Sprintf(
		`{"name":"Acme","anchor":{"lat":%v,"lng":%v},"timezone":"America/Vancouver"}`, vanLat, vanLng)),
		http.StatusCreated, &body)
	return body.Employer.ID
}

// member signs the address in and names it before the invitation is created, so
// the membership is claimed on add and the report's name join has something to
// find. Returns the user document, which the entry store needs for its DEK.
func (a *testAPI) member(t *testing.T, ownerToken, employerID, email, name string, rateCents int64) *user.User {
	t.Helper()
	token := a.token(t, email)
	if rec := a.do(http.MethodPatch, "/v1/me", token, `{"name":"`+name+`"}`); rec.Code != http.StatusOK {
		t.Fatalf("sign in %s: status = %d: %s", email, rec.Code, rec.Body)
	}
	var added struct {
		Member struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"member"`
	}
	decodeBody(t, a.do(http.MethodPost, "/v1/employers/"+employerID+"/members", ownerToken,
		`{"email":"`+email+`"}`), http.StatusCreated, &added)
	if added.Member.Status != "active" {
		t.Fatalf("member %s status = %q, want active", email, added.Member.Status)
	}
	if rec := a.do(http.MethodPatch, "/v1/employers/"+employerID+"/members/"+added.Member.ID, ownerToken,
		fmt.Sprintf(`{"hourly_rate_cents":%d}`, rateCents)); rec.Code != http.StatusNoContent {
		t.Fatalf("set rate for %s: status = %d: %s", email, rec.Code, rec.Body)
	}

	var u user.User
	if err := a.db.Collection("users").FindOne(context.Background(), bson.M{"email": email}).Decode(&u); err != nil {
		t.Fatal(err)
	}
	return &u
}

// recordShift writes a closed shift through the entry store rather than the
// endpoints: the clock-in handler rejects fixture timestamps as clock skew, and
// the report only ever reads what the store holds.
func (a *testAPI) recordShift(t *testing.T, u *user.User, employerID, clientID string, in, out time.Time) {
	t.Helper()
	ctx := context.Background()
	eid, err := bson.ObjectIDFromHex(employerID)
	if err != nil {
		t.Fatal(err)
	}
	fix := func(at time.Time) entry.Fix {
		return entry.Fix{Lat: vanLat, Lng: vanLng, AccuracyM: 10, At: at}
	}
	open, _, err := a.entries.ClockIn(ctx, u, &eid, clientID, fix(in))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.entries.ClockOut(ctx, u, open, clientID+"-close", fix(out)); err != nil {
		t.Fatal(err)
	}
}

func assertRow(t *testing.T, got reportRow, u *user.User, minutes, rate, base, tip, total int64) {
	t.Helper()
	if got.User.ID != u.ID || got.User.Name != u.Name {
		t.Fatalf("row = %+v, want %s (%s)", got, u.Name, u.ID.Hex())
	}
	if got.Minutes != minutes || got.TipShareCents != tip || got.TotalCents != total {
		t.Fatalf("row %s = %+v, want %d min, %d¢ tip, %d¢ total", u.Name, got, minutes, tip, total)
	}
	if got.HourlyRateCents == nil || *got.HourlyRateCents != rate {
		t.Fatalf("row %s rate = %v, want %d¢/h", u.Name, got.HourlyRateCents, rate)
	}
	if got.BasePayCents == nil || *got.BasePayCents != base {
		t.Fatalf("row %s base pay = %v, want %d¢", u.Name, got.BasePayCents, base)
	}
}

// The payroll report end to end, asserted to the cent: two people on known
// rates, a shift that crosses midnight, a shift that starts at 23:30 local, and
// one day's tip pool split between them.
func TestReportFixtureSplitsToTheCent(t *testing.T) {
	api := newTestAPI(t)
	ownerToken := api.token(t, "owner@example.com")
	employerID := api.createEmployer(t, ownerToken)
	ana := api.member(t, ownerToken, employerID, "ana@example.com", "Ana", 1800)
	bo := api.member(t, ownerToken, employerID, "bo@example.com", "Bo", 2200)

	loc, err := time.LoadLocation("America/Vancouver")
	if err != nil {
		t.Fatal(err)
	}
	// The fixture is written in UTC on purpose: which local day an instant lands
	// on is the thing under test, so every one of them is asserted, not assumed.
	at := func(utc, wantLocal string) time.Time {
		t.Helper()
		ts, err := time.Parse(time.RFC3339, utc)
		if err != nil {
			t.Fatal(err)
		}
		if got := ts.In(loc).Format("2006-01-02 15:04"); got != wantLocal {
			t.Fatalf("%s is %s in Vancouver, want %s", utc, got, wantLocal)
		}
		return ts
	}

	// 480 minutes inside one local day.
	api.recordShift(t, ana, employerID, "ana-1",
		at("2026-06-15T16:00:00Z", "2026-06-15 09:00"),
		at("2026-06-16T00:00:00Z", "2026-06-15 17:00"))
	// 240 minutes across midnight. Both UTC instants are already the 16th; the
	// shift is paid on the 15th it started on (design §4.6).
	api.recordShift(t, bo, employerID, "bo-1",
		at("2026-06-16T05:00:00Z", "2026-06-15 22:00"),
		at("2026-06-16T09:00:00Z", "2026-06-16 02:00"))
	// The timezone edge: 23:30 local is the 16th, never the UTC 17th.
	api.recordShift(t, ana, employerID, "ana-2",
		at("2026-06-17T06:30:00Z", "2026-06-16 23:30"),
		at("2026-06-17T07:30:00Z", "2026-06-17 00:30"))

	if rec := api.do(http.MethodPut, "/v1/employers/"+employerID+"/tips/2026-06-15", ownerToken,
		`{"amount_cents":10000}`); rec.Code != http.StatusOK {
		t.Fatalf("put tip: status = %d: %s", rec.Code, rec.Body)
	}

	var body struct {
		Days []reportDay `json:"days"`
	}
	decodeBody(t, api.do(http.MethodGet,
		"/v1/employers/"+employerID+"/report?from=2026-06-15&to=2026-06-16", ownerToken, ""),
		http.StatusOK, &body)
	// Two days: the tail of Ana's overnight shift must not open a third.
	if len(body.Days) != 2 {
		t.Fatalf("days = %+v, want the 15th and the 16th only", body.Days)
	}

	// Base pay by hand: Ana 1800*480/60 = 14400, Bo 2200*240/60 = 8800.
	// Tip split by hand: Ana 10000*480/720 = 6666 remainder 480, Bo
	// 10000*240/720 = 3333 remainder 240. The floors sum to 9999, so the single
	// leftover cent goes to the larger remainder, Ana's.
	first := body.Days[0]
	if first.Date != "2026-06-15" || first.TipCents != 10000 || first.TotalMinutes != 720 ||
		first.TotalBasePayCents != 23200 || first.TotalTipShareCents != 10000 || first.TotalCents != 33200 {
		t.Fatalf("15th = %+v, want 720 min, 23200¢ base, 10000¢ tips, 33200¢ total", first)
	}
	if len(first.Rows) != 2 {
		t.Fatalf("15th rows = %+v, want Ana and Bo", first.Rows)
	}
	assertRow(t, first.Rows[0], ana, 480, 1800, 14400, 6667, 21067)
	assertRow(t, first.Rows[1], bo, 240, 2200, 8800, 3333, 12133)

	second := body.Days[1]
	if second.Date != "2026-06-16" || second.TipCents != 0 || second.TotalMinutes != 60 ||
		second.TotalBasePayCents != 1800 || second.TotalTipShareCents != 0 || second.TotalCents != 1800 {
		t.Fatalf("16th = %+v, want 60 min, 1800¢ base and no tip", second)
	}
	if len(second.Rows) != 1 {
		t.Fatalf("16th rows = %+v, want Ana's 23:30 shift alone", second.Rows)
	}
	assertRow(t, second.Rows[0], ana, 60, 1800, 1800, 0, 1800)
}
