package tip

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/entry"
	"github.com/setthasit/clockit/backend/internal/httpx"
	"github.com/setthasit/clockit/backend/internal/mongox"
	"github.com/setthasit/clockit/backend/internal/user"
)

// testHandler wires the real stores against a throwaway database, and returns
// the owner the handlers will see plus their employer.
func testHandler(t *testing.T) (*Handler, *user.User, *employer.Employer) {
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
// go unpaid. instantWindow keeps an hour of slack on both sides instead.
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
