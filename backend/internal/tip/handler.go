package tip

import (
	"errors"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/entry"
	"github.com/setthasit/clockit/backend/internal/httpx"
	"github.com/setthasit/clockit/backend/internal/user"
	"github.com/setthasit/clockit/backend/internal/valkeyx"
)

// dayLayout is the wire and storage format of a report day: a calendar date in
// the employer's timezone. time.Parse is strict on it (fixed-width fields, real
// calendar dates only), so an accepted string is already canonical.
const dayLayout = "2006-01-02"

// maxTipCents caps one day's pool at $1,000,000 — orders of magnitude above any
// real shift's tips, so it only ever catches a client sending dollars as cents
// or a stray keystroke. It also puts a hard ceiling on the arithmetic in
// SplitByMinutes, which no realistic input could approach anyway.
const maxTipCents = 100_000_000

type Handler struct {
	store *Store
	// employers is the ownership gate plus the rate and name join; entries
	// supplies the minutes the report is built from.
	employers *employer.Store
	entries   *entry.Store
}

func NewHandler(store *Store, employers *employer.Store, entries *entry.Store) *Handler {
	return &Handler{store: store, employers: employers, entries: entries}
}

func RegisterRoutes(e *echo.Echo, h *Handler, userStore *user.Store, authMW echo.MiddlewareFunc, vk valkey.Client, cfg config.Config) {
	userMW := user.Middleware(userStore)
	rateLimit := valkeyx.RateLimit(vk, cfg)
	e.PUT("/v1/employers/:id/tips/:date", h.Put, authMW, rateLimit, userMW)
	e.GET("/v1/employers/:id/tips", h.List, authMW, userMW)
	e.GET("/v1/employers/:id/report", h.Report, authMW, userMW)
}

type putRequest struct {
	// Pointer: a missing amount is a malformed request, not a request to zero
	// the pool. Zero itself is meaningful — it clears a tip that was entered by
	// mistake.
	AmountCents *int64 `json:"amount_cents"`
}

func (h *Handler) Put(c echo.Context) error {
	e, err := h.owned(c)
	if err != nil {
		return err
	}
	date, err := parseDay("date", c.Param("date"))
	if err != nil {
		return err
	}
	var req putRequest
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	if req.AmountCents == nil {
		return httpx.Invalid("amount_cents is required")
	}
	cents := *req.AmountCents
	if cents < 0 {
		return httpx.Invalid("amount_cents must not be negative")
	}
	if cents > maxTipCents {
		return httpx.Invalid("amount_cents is implausibly large")
	}

	if err := h.store.Upsert(c.Request().Context(), e.ID, date, cents); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, echo.Map{"tip": view{Date: date, AmountCents: cents}})
}

func (h *Handler) List(c echo.Context) error {
	e, err := h.owned(c)
	if err != nil {
		return err
	}
	from, to, err := dayWindow(c)
	if err != nil {
		return err
	}
	tips, err := h.store.List(c.Request().Context(), e.ID, from, to)
	if err != nil {
		return err
	}
	out := make([]view, 0, len(tips))
	for _, t := range tips {
		out = append(out, view{Date: t.Date, AmountCents: t.AmountCents})
	}
	return c.JSON(http.StatusOK, echo.Map{"tips": out})
}

// reportRow is one member's day. hourly_rate_cents is null when the employer
// never set a rate, and base_pay_cents is then null too — unknown pay, which the
// table renders blank, not zero. The tip share is owed regardless: it comes from
// minutes worked, not from a rate.
//
// ponytail: no flags field, so a row can hold hours a `backdated` entry
// asserted days late (design §4.5) and read as ordinary minutes. The report is
// computed on read and the flag lives on the entry, so adding the field later
// surfaces past shifts too — do it when the web report has somewhere to show it.
type reportRow struct {
	User            employer.UserRef `json:"user"`
	Minutes         int64            `json:"minutes"`
	HourlyRateCents *int64           `json:"hourly_rate_cents"`
	BasePayCents    *int64           `json:"base_pay_cents"`
	TipShareCents   int64            `json:"tip_share_cents"`
	TotalCents      int64            `json:"total_cents"`
}

// reportDay carries its own totals so the table and the CSV never re-add cents
// client-side. total_tip_share_cents equals tip_cents whenever anybody worked;
// it differs only when a tip was entered for a day with no minutes, which is
// exactly the "unassigned tip" the design leaves visible (§4.6).
type reportDay struct {
	Date               string      `json:"date"`
	TipCents           int64       `json:"tip_cents"`
	TotalMinutes       int64       `json:"total_minutes"`
	TotalBasePayCents  int64       `json:"total_base_pay_cents"`
	TotalTipShareCents int64       `json:"total_tip_share_cents"`
	TotalCents         int64       `json:"total_cents"`
	Rows               []reportRow `json:"rows"`
}

// Report is payroll for a range of days: hours, base pay and tip shares per
// member per day. Everything is computed on read (design §4.6) — editing a tip
// or a shift can therefore never leave a stale split behind.
func (h *Handler) Report(c echo.Context) error {
	e, err := h.owned(c)
	if err != nil {
		return err
	}
	from, to, err := dayWindow(c)
	if err != nil {
		return err
	}
	// Validated on write, so a failure here is corrupt storage, not bad input.
	loc, err := time.LoadLocation(e.Timezone)
	if err != nil {
		return err
	}
	fromUTC, toUTC, err := instantWindow(from, to, loc)
	if err != nil {
		return err
	}

	ctx := c.Request().Context()
	entries, err := h.entries.ListByEmployer(ctx, e.ID, fromUTC, toUTC)
	if err != nil {
		return err
	}
	// Every membership, removed ones included: a past shift keeps its worker's
	// name and the rate it was paid at (design §11.5).
	members, err := h.employers.ListMembers(ctx, e)
	if err != nil {
		return err
	}
	tips, err := h.store.List(ctx, e.ID, from, to)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, echo.Map{"days": buildReport(entries, members, tips, loc, from, to)})
}

// buildReport is the whole report: pure, so the money arithmetic is testable
// without a database. from and to are the requested day bounds (either may be
// empty); the entry query only approximates them, so this is where they bind.
func buildReport(entries []entry.Entry, members []employer.Member, tips []Tip, loc *time.Location, from, to string) []reportDay {
	byUser := make(map[bson.ObjectID]employer.Member, len(members))
	for _, m := range members {
		if m.UserID != nil {
			byUser[*m.UserID] = m
		}
	}
	tipByDay := make(map[string]int64, len(tips))
	minutesByDay := map[string]map[bson.ObjectID]int64{}
	for _, t := range tips {
		tipByDay[t.Date] = t.AmountCents
		// Seeded so a tip on a day nobody worked still gets a row: an employer
		// who typed $500 on the wrong date has to see it to correct it (§4.6).
		minutesByDay[t.Date] = map[bson.ObjectID]int64{}
	}

	for i := range entries {
		e := &entries[i]
		if e.ClockOut == nil {
			continue // still running: no minutes to pay yet
		}
		if _, ok := byUser[e.UserID]; !ok {
			continue // clock-in requires a membership, so this is corrupt data
		}
		// A shift belongs to the local day it started on, even when it ends on
		// the next one (design §4.6).
		day := e.ClockIn.At.In(loc).Format(dayLayout)
		if (from != "" && day < from) || (to != "" && day > to) {
			continue // only the slack instantWindow allows in, never a real day
		}
		if minutesByDay[day] == nil {
			minutesByDay[day] = map[bson.ObjectID]int64{}
		}
		minutesByDay[day][e.UserID] += int64(e.ClockOut.At.Sub(e.ClockIn.At).Round(time.Minute) / time.Minute)
	}

	days := make([]reportDay, 0, len(minutesByDay))
	for day, worked := range minutesByDay {
		days = append(days, buildDay(day, tipByDay[day], worked, byUser))
	}
	slices.SortFunc(days, func(a, b reportDay) int { return strings.Compare(a.Date, b.Date) })
	return days
}

// buildDay splits one day's pool across the people who worked it. Rows are
// ordered by name before the split runs, so the same day always splits the same
// way rather than following Mongo's or a map's iteration order.
func buildDay(date string, tipCents int64, worked map[bson.ObjectID]int64, members map[bson.ObjectID]employer.Member) reportDay {
	ids := slices.Collect(maps.Keys(worked))
	slices.SortFunc(ids, func(a, b bson.ObjectID) int {
		if byName := strings.Compare(members[a].Name, members[b].Name); byName != 0 {
			return byName
		}
		return strings.Compare(a.Hex(), b.Hex())
	})

	minutes := make([]int64, len(ids))
	for i, id := range ids {
		minutes[i] = worked[id]
	}
	shares := SplitByMinutes(tipCents, minutes)

	day := reportDay{Date: date, TipCents: tipCents, Rows: make([]reportRow, 0, len(ids))}
	for i, id := range ids {
		m := members[id]
		row := reportRow{
			User:            employer.UserRef{ID: id, Name: m.Name, Email: m.Email},
			Minutes:         minutes[i],
			HourlyRateCents: m.HourlyRateCents,
			TipShareCents:   shares[i],
			TotalCents:      shares[i],
		}
		if m.HourlyRateCents != nil {
			base := basePayCents(*m.HourlyRateCents, minutes[i])
			row.BasePayCents = &base
			row.TotalCents += base
			day.TotalBasePayCents += base
		}
		day.TotalMinutes += row.Minutes
		day.TotalTipShareCents += row.TipShareCents
		day.TotalCents += row.TotalCents
		day.Rows = append(day.Rows, row)
	}
	return day
}

// basePayCents is rate x minutes / 60 rounded to the nearest cent, in integers:
// a float hour count would make 7h20m at 1875¢/h land a cent off depending on
// the value. Both inputs are non-negative (the rate is validated on write,
// minutes come from a closed shift), so +30 before the divide rounds half up.
func basePayCents(rateCents, minutes int64) int64 {
	return (rateCents*minutes + 30) / 60
}

// owned is the authorization gate every route here runs first: a foreign or
// malformed employer id is a 404, never a 403.
func (h *Handler) owned(c echo.Context) (*employer.Employer, error) {
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		return nil, httpx.NotFound()
	}
	e, err := h.employers.GetOwned(c.Request().Context(), id, user.CurrentUser(c).ID)
	if err != nil {
		if errors.Is(err, employer.ErrNotFound) {
			return nil, httpx.NotFound()
		}
		return nil, err
	}
	return e, nil
}

// dayWindow reads the optional [from, to] day bounds, compared as strings
// because YYYY-MM-DD sorts chronologically.
//
// ponytail: both bounds optional means an omitted range scans an employer's
// whole history; fine at a few years of days, add a limit or require a range
// once that stops being true.
func dayWindow(c echo.Context) (string, string, error) {
	from, err := parseDay("from", c.QueryParam("from"))
	if err != nil {
		return "", "", err
	}
	to, err := parseDay("to", c.QueryParam("to"))
	if err != nil {
		return "", "", err
	}
	if from != "" && to != "" && to < from {
		return "", "", httpx.Invalid("from must not be after to")
	}
	return from, to, nil
}

// parseDay validates a calendar day and returns it unchanged; empty means the
// caller omitted an optional bound.
func parseDay(name, raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if _, err := time.Parse(dayLayout, raw); err != nil {
		return "", httpx.Invalid(name + " must be a YYYY-MM-DD date")
	}
	return raw, nil
}

// instantWindow prefilters clock_in.at with a day of slack on each side — a
// superset of the requested local days under any zone's offset changes, since
// buildReport's local date string is what actually binds an entry to a day.
func instantWindow(from, to string, loc *time.Location) (*time.Time, *time.Time, error) {
	const slack = 24 * time.Hour
	var fromAt, toAt *time.Time
	if from != "" {
		t, err := time.ParseInLocation(dayLayout, from, loc)
		if err != nil {
			return nil, nil, err
		}
		start := t.Add(-slack)
		fromAt = &start
	}
	if to != "" {
		t, err := time.ParseInLocation(dayLayout, to, loc)
		if err != nil {
			return nil, nil, err
		}
		next := t.AddDate(0, 0, 1).Add(slack)
		toAt = &next
	}
	return fromAt, toAt, nil
}
