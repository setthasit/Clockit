package entry

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/httpx"
	"github.com/setthasit/clockit/backend/internal/user"
	"github.com/setthasit/clockit/backend/internal/valkeyx"
)

// maxClientIDLen keeps a hostile client_id out of the unique index, whose keys
// are size-limited; a UUIDv4 is 36 characters.
const maxClientIDLen = 64

// maxPingBatch bounds one outbox flush. The mobile client pings every 10
// minutes, so 64 covers more than ten hours of backlog: a larger batch is a
// client bug, and truncating it would hide that while silently dropping
// evidence.
const maxPingBatch = 64

type Handler struct {
	store *Store
	// employers resolves the anchor and the membership behind an employer entry.
	employers *employer.Store
	cfg       config.Config
}

func NewHandler(store *Store, employers *employer.Store, cfg config.Config) *Handler {
	return &Handler{store: store, employers: employers, cfg: cfg}
}

func RegisterRoutes(e *echo.Echo, h *Handler, userStore *user.Store, authMW echo.MiddlewareFunc, vk valkey.Client, cfg config.Config) {
	userMW := user.Middleware(userStore)
	rateLimit := valkeyx.RateLimit(vk, cfg)
	e.POST("/v1/entries/clock-in", h.ClockIn, authMW, rateLimit, userMW)
	e.POST("/v1/entries/clock-out", h.ClockOut, authMW, rateLimit, userMW)
	e.GET("/v1/entries", h.List, authMW, userMW)
	e.PATCH("/v1/entries/:id", h.Assign, authMW, rateLimit, userMW)
	e.POST("/v1/pings", h.Pings, authMW, rateLimit, userMW)
	// Employer-scoped path, entry-owned data: this package already holds both
	// the time_entries store and the employer store the ownership check needs.
	e.GET("/v1/employers/:id/entries", h.EmployerList, authMW, userMW)
}

// clockPointView carries plaintext coordinates: this projection is only ever
// returned to the entry's owner.
type clockPointView struct {
	At        time.Time       `json:"at"`
	Loc       employer.LatLng `json:"loc"`
	AccuracyM float64         `json:"accuracy"`
	Mocked    bool            `json:"mocked"`
}

type view struct {
	ID               bson.ObjectID   `json:"id"`
	ClientID         string          `json:"client_id"`
	EmployerID       *bson.ObjectID  `json:"employer_id"`
	Status           string          `json:"status"`
	ClockIn          clockPointView  `json:"clock_in"`
	ClockOut         *clockPointView `json:"clock_out"`
	LocationVerified bool            `json:"location_verified"`
	Flags            []string        `json:"flags"`
	CreatedAt        time.Time       `json:"created_at"`
}

type locBody struct {
	// Pointers: an omitted coordinate must not arrive as a valid 0 — Null Island
	// is a real place, so absence and zero cannot share a representation.
	Lat      *float64 `json:"lat"`
	Lng      *float64 `json:"lng"`
	Accuracy *float64 `json:"accuracy"`
}

type clockRequest struct {
	ClientID   string    `json:"client_id"`
	EmployerID *string   `json:"employer_id"`
	At         time.Time `json:"at"`
	Loc        *locBody  `json:"loc"`
	Mocked     bool      `json:"mocked"`
}

// ponytail: presence and length only; clients send a UUIDv4 and the unique
// index is what actually has to hold. Parse it as a UUID if a stricter contract
// ever earns its keep.
func (r *clockRequest) clientID() (string, error) {
	id := strings.TrimSpace(r.ClientID)
	if id == "" {
		return "", httpx.Invalid("client_id is required")
	}
	if len(id) > maxClientIDLen {
		return "", httpx.Invalid("client_id is too long")
	}
	return id, nil
}

// fix shapes the body into a Fix. Only presence and range are checked here; the
// design §4.5 rules run later, after the idempotency lookup, so a replay of an
// old event is not rejected for being old.
func (r *clockRequest) fix() (Fix, error) {
	if r.At.IsZero() {
		return Fix{}, httpx.Invalid("at is required")
	}
	loc, err := r.Loc.latLng()
	if err != nil {
		return Fix{}, err
	}
	if r.Loc.Accuracy == nil {
		return Fix{}, httpx.Invalid("loc requires accuracy")
	}
	if *r.Loc.Accuracy < 0 {
		return Fix{}, httpx.Invalid("accuracy must not be negative")
	}
	return Fix{Lat: loc.Lat, Lng: loc.Lng, AccuracyM: *r.Loc.Accuracy, At: msTime(r.At), Mocked: r.Mocked}, nil
}

// latLng checks presence and range. Accuracy is the caller's business: a clock
// event is judged on it, a ping is not.
func (l *locBody) latLng() (employer.LatLng, error) {
	if l == nil || l.Lat == nil || l.Lng == nil {
		return employer.LatLng{}, httpx.Invalid("loc requires lat and lng")
	}
	if *l.Lat < -90 || *l.Lat > 90 {
		return employer.LatLng{}, httpx.Invalid("lat must be within [-90, 90]")
	}
	if *l.Lng < -180 || *l.Lng > 180 {
		return employer.LatLng{}, httpx.Invalid("lng must be within [-180, 180]")
	}
	return employer.LatLng{Lat: *l.Lat, Lng: *l.Lng}, nil
}

func (h *Handler) ClockIn(c echo.Context) error {
	var obs clockObs
	err := h.clockIn(c, &obs)
	obs.reportClockIn(c.Request().Context(), err)
	return err
}

func (h *Handler) clockIn(c echo.Context, obs *clockObs) error {
	var req clockRequest
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	clientID, err := req.clientID()
	if err != nil {
		return err
	}
	fix, err := req.fix()
	if err != nil {
		return err
	}
	obs.fix = &fix

	ctx := c.Request().Context()
	u := user.CurrentUser(c)

	// Idempotency first: the outbox replays clock-ins, and a replay must return
	// the original entry rather than fail the location rules a second time.
	existing, err := h.store.ByClientID(ctx, u.ID, clientID)
	if err != nil {
		return err
	}
	if existing != nil {
		obs.replay = true
		return h.respond(c, http.StatusOK, u, existing)
	}

	employerID, err := parseEmployerID(req.EmployerID)
	if err != nil {
		return err
	}
	anchor, err := h.anchor(ctx, employerID, u.ID)
	if err != nil {
		return err
	}
	obs.anchor = anchor
	if appErr := ValidateFix(h.cfg, time.Now(), fix, anchor); appErr != nil {
		return appErr
	}

	e, replayed, err := h.store.ClockIn(ctx, u, employerID, clientID, fix)
	if errors.Is(err, ErrOpenEntryExists) {
		return httpx.OpenEntryExists()
	}
	if err != nil {
		return err
	}
	if replayed {
		obs.replay = true
		return h.respond(c, http.StatusOK, u, e)
	}
	return h.respond(c, http.StatusCreated, u, e)
}

func (h *Handler) ClockOut(c echo.Context) error {
	var obs clockObs
	err := h.clockOut(c, &obs)
	obs.report(c.Request().Context(), err)
	return err
}

func (h *Handler) clockOut(c echo.Context, obs *clockObs) error {
	var req clockRequest
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	clientID, err := req.clientID()
	if err != nil {
		return err
	}
	fix, err := req.fix()
	if err != nil {
		return err
	}
	obs.fix = &fix

	ctx := c.Request().Context()
	u := user.CurrentUser(c)

	// Idempotency first, same reason as clock-in: a replayed close must return
	// the closed entry rather than fail the location rules a second time.
	closed, err := h.store.ByCloseClientID(ctx, u.ID, clientID)
	if err != nil {
		return err
	}
	if closed != nil {
		obs.replay = true
		return h.respond(c, http.StatusOK, u, closed)
	}

	open, err := h.store.OpenEntry(ctx, u.ID)
	if err != nil {
		return err
	}
	if open == nil {
		return h.closedOrConflict(c, u, clientID, obs)
	}
	// Cheap ordering check before the crypto and the employer read.
	if !fix.At.After(open.ClockIn.At) {
		return httpx.Invalid("clock-out must be after clock-in")
	}
	anchor, err := h.closeAnchor(ctx, u, open)
	if err != nil {
		return err
	}
	obs.anchor = anchor
	if appErr := ValidateFix(h.cfg, time.Now(), fix, anchor); appErr != nil {
		return appErr
	}

	e, err := h.store.ClockOut(ctx, u, open, clientID, fix)
	if errors.Is(err, ErrEntryNotOpen) {
		return h.closedOrConflict(c, u, clientID, obs)
	}
	if err != nil {
		return err
	}
	// 200, not 201: closing a shift updates the entry created at clock-in.
	return h.respond(c, http.StatusOK, u, e)
}

// closedOrConflict answers a clock-out that found nothing to close. The
// pre-flight idempotency lookup can run a moment before a concurrent replay of
// this same close commits, so the shift may already be closed under this very
// client_id — that is a replay and must answer with the entry. Only a genuinely
// missing shift is a conflict.
func (h *Handler) closedOrConflict(c echo.Context, u *user.User, clientID string, obs *clockObs) error {
	closed, err := h.store.ByCloseClientID(c.Request().Context(), u.ID, clientID)
	if err != nil {
		return err
	}
	if closed != nil {
		obs.replay = true
		return h.respond(c, http.StatusOK, u, closed)
	}
	return httpx.NoOpenEntry()
}

type pingBody struct {
	At time.Time `json:"at"`
	// Accuracy rides along in loc for symmetry with the clock endpoints; nothing
	// server-side judges a breadcrumb on it, so it is read and dropped.
	Loc *locBody `json:"loc"`
}

// Pings stores a flush of background breadcrumbs against the caller's running
// shift. It never rejects on position — people move (design §4.5) — it only
// flags travel that is physically impossible.
func (h *Handler) Pings(c echo.Context) error {
	var req struct {
		Pings []pingBody `json:"pings"`
	}
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	fixes, err := pingFixes(req.Pings)
	if err != nil {
		return err
	}

	ctx := c.Request().Context()
	u := user.CurrentUser(c)
	open, err := h.store.OpenEntry(ctx, u.ID)
	if err != nil {
		return err
	}
	// No shift to attach to: the flush raced the clock-out, or the batch was
	// empty. Both are answered as accepted-and-dropped, because an error here
	// would leave the client's outbox retrying breadcrumbs forever.
	if open == nil || len(fixes) == 0 {
		return c.JSON(http.StatusOK, echo.Map{"accepted": 0})
	}

	anomaly, err := h.speedAnomaly(ctx, u, open, fixes)
	if err != nil {
		return err
	}
	n, err := h.store.AddPings(ctx, u, open.ID, fixes)
	if err != nil {
		return err
	}
	if anomaly {
		if err := h.store.Flag(ctx, open, flagSpeedAnomaly); err != nil {
			return err
		}
	}
	return c.JSON(http.StatusOK, echo.Map{"accepted": n})
}

// pingFixes validates the batch and puts it in time order: the outbox flushes
// whatever it queued, and a speed check on unordered fixes measures nothing.
//
// One bad ping fails the whole batch. A flush is one atomic unit for the
// client, and partial acceptance would leave it guessing which breadcrumbs to
// re-queue.
func pingFixes(body []pingBody) ([]Fix, error) {
	if len(body) > maxPingBatch {
		return nil, httpx.Invalid("a batch carries at most 64 pings")
	}
	fixes := make([]Fix, 0, len(body))
	for _, p := range body {
		if p.At.IsZero() {
			return nil, httpx.Invalid("each ping requires at")
		}
		loc, err := p.Loc.latLng()
		if err != nil {
			return nil, err
		}
		fixes = append(fixes, Fix{Lat: loc.Lat, Lng: loc.Lng, At: msTime(p.At)})
	}
	slices.SortStableFunc(fixes, func(a, b Fix) int { return a.At.Compare(b.At) })
	return fixes, nil
}

// speedAnomaly walks the batch against the last point already on record — the
// previous ping, or the clock-in when this is the first flush — so a jump
// across the seam between stored and new breadcrumbs counts too.
func (h *Handler) speedAnomaly(ctx context.Context, u *user.User, e *Entry, fixes []Fix) (bool, error) {
	last, err := h.store.LastPing(ctx, e.ID)
	if err != nil {
		return false, err
	}
	locEnc, at := e.ClockIn.LocEnc, e.ClockIn.At
	if last != nil {
		locEnc, at = last.LocEnc, last.At
	}
	loc, err := h.store.openLoc(ctx, u, locEnc)
	if err != nil {
		return false, err
	}

	prev := Fix{Lat: loc.Lat, Lng: loc.Lng, At: at}
	for _, f := range fixes {
		if SpeedAnomaly(h.cfg, prev, f) {
			return true, nil
		}
		prev = f
	}
	return false, nil
}

func (h *Handler) List(c echo.Context) error {
	from, to, err := window(c)
	if err != nil {
		return err
	}

	ctx := c.Request().Context()
	u := user.CurrentUser(c)
	entries, err := h.store.List(ctx, u.ID, from, to)
	if err != nil {
		return err
	}
	views := make([]view, 0, len(entries))
	for i := range entries {
		v, err := h.view(ctx, u, &entries[i])
		if err != nil {
			return err
		}
		views = append(views, v)
	}
	return c.JSON(http.StatusOK, echo.Map{"entries": views})
}

// employerView is what an employer is entitled to see about a member's shift:
// when it ran and how it was judged. No coordinates, and no accuracy or mocked
// either — those are properties of the fix, and the employer gets verdicts, not
// tracks (design §4.5, plan §5.5). Mocked fixes are rejected at capture, so
// their absence here hides nothing that was accepted.
type employerView struct {
	ID         bson.ObjectID    `json:"id"`
	User       employer.UserRef `json:"user"`
	Status     string           `json:"status"`
	ClockInAt  time.Time        `json:"clock_in_at"`
	ClockOutAt *time.Time       `json:"clock_out_at"`
	// DurationMinutes is display-only, rounded to the nearest minute; the payroll
	// report (§6.2) does its own money-grade minutes math.
	DurationMinutes  *int64   `json:"duration_minutes"`
	LocationVerified bool     `json:"location_verified"`
	Flags            []string `json:"flags"`
}

// EmployerList is the calendar and table feed: every shift booked to one
// employer, newest first, joined with who worked it.
func (h *Handler) EmployerList(c echo.Context) error {
	employerID, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		// A malformed id is answered like a foreign one, so the endpoint never
		// confirms which ids exist.
		return httpx.NotFound()
	}
	from, to, err := window(c)
	if err != nil {
		return err
	}

	ctx := c.Request().Context()
	if _, err := h.employers.GetOwned(ctx, employerID, user.CurrentUser(c).ID); err != nil {
		if errors.Is(err, employer.ErrNotFound) {
			return httpx.NotFound()
		}
		return err
	}
	entries, err := h.store.ListByEmployer(ctx, employerID, from, to)
	if err != nil {
		return err
	}
	ids := make([]bson.ObjectID, 0, len(entries))
	for i := range entries {
		ids = append(ids, entries[i].UserID)
	}
	users, err := h.employers.UsersByID(ctx, ids)
	if err != nil {
		return err
	}

	views := make([]employerView, 0, len(entries))
	for i := range entries {
		views = append(views, newEmployerView(&entries[i], users[entries[i].UserID]))
	}
	return c.JSON(http.StatusOK, echo.Map{"entries": views})
}

func newEmployerView(e *Entry, u employer.UserRef) employerView {
	v := employerView{
		ID:               e.ID,
		User:             u,
		Status:           e.Status,
		ClockInAt:        e.ClockIn.At,
		LocationVerified: e.LocationVerified,
		Flags:            e.Flags,
	}
	if v.Flags == nil {
		v.Flags = []string{}
	}
	if e.ClockOut != nil {
		minutes := int64(e.ClockOut.At.Sub(e.ClockIn.At).Round(time.Minute) / time.Minute)
		v.ClockOutAt, v.DurationMinutes = &e.ClockOut.At, &minutes
	}
	return v
}

// Assign attaches an employer to a personal entry after the fact. It never
// rejects on location (design §4.5.5): a shift that happened outside the
// employer's zone is still a real shift, it is just recorded unverified.
func (h *Handler) Assign(c echo.Context) error {
	entryID, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		// A malformed id is answered like a foreign one, so the endpoint never
		// confirms which ids exist.
		return httpx.NotFound()
	}
	var req struct {
		EmployerID *string `json:"employer_id"`
	}
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	employerID, err := parseEmployerID(req.EmployerID)
	if err != nil {
		return err
	}
	if employerID == nil {
		return httpx.Invalid("employer_id is required")
	}

	ctx := c.Request().Context()
	u := user.CurrentUser(c)
	e, err := h.store.ByID(ctx, u.ID, entryID)
	if err != nil {
		return err
	}
	if e == nil {
		return httpx.NotFound()
	}
	if e.EmployerID != nil {
		return httpx.Invalid("entry already has an employer")
	}
	// Assignment is one-way and records a shift that already happened (§4.5.5).
	// On an open entry it would re-point the clock-out at the employer's anchor,
	// so a personal shift started out of zone could never be closed.
	if e.Status != statusClosed {
		return httpx.Invalid("only a closed entry can be assigned")
	}

	anchor, err := h.anchor(ctx, employerID, u.ID)
	if err != nil {
		return err
	}
	verified, err := h.withinAnchor(ctx, u, e, *anchor)
	if err != nil {
		return err
	}

	assigned, err := h.store.Assign(ctx, e, *employerID, verified)
	if errors.Is(err, ErrAlreadyAssigned) {
		return httpx.Invalid("entry already has an employer")
	}
	if err != nil {
		return err
	}
	return h.respond(c, http.StatusOK, u, assigned)
}

// withinAnchor re-measures the entry's fixes against an employer's centre.
// Position only: mock, accuracy and skew were judged when the fix was captured,
// and re-judging skew now would mark every past entry unverified.
//
// Callers only assign closed entries, so both fixes are normally present; the
// nil clock-out stays handled so bad data measures the clock-in alone rather
// than panicking.
func (h *Handler) withinAnchor(ctx context.Context, u *user.User, e *Entry, anchor employer.LatLng) (bool, error) {
	points := []*ClockPoint{&e.ClockIn}
	if e.ClockOut != nil {
		points = append(points, e.ClockOut)
	}
	for _, p := range points {
		loc, err := h.store.openLoc(ctx, u, p.LocEnc)
		if err != nil {
			return false, err
		}
		if !WithinAnchor(h.cfg, loc, anchor) {
			return false, nil
		}
	}
	return true, nil
}

// window reads the optional [from, to) query bounds shared by both list views.
func window(c echo.Context) (*time.Time, *time.Time, error) {
	from, err := timeParam(c, "from")
	if err != nil {
		return nil, nil, err
	}
	to, err := timeParam(c, "to")
	if err != nil {
		return nil, nil, err
	}
	if from != nil && to != nil && to.Before(*from) {
		return nil, nil, httpx.Invalid("from must not be after to")
	}
	return from, to, nil
}

// timeParam reads an optional RFC3339 range bound; absent means unbounded.
func timeParam(c echo.Context, name string) (*time.Time, error) {
	raw := c.QueryParam(name)
	if raw == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return nil, httpx.Invalid(name + " must be an RFC3339 timestamp")
	}
	return &t, nil
}

// closeAnchor measures an employer shift against the employer's centre and a
// personal one against where it started (design §4.5).
//
// Membership is deliberately not re-checked: the shift is already the caller's,
// and someone removed from the employer mid-shift must still be able to close
// it rather than stay clocked in forever.
func (h *Handler) closeAnchor(ctx context.Context, u *user.User, e *Entry) (*employer.LatLng, error) {
	if e.EmployerID == nil {
		loc, err := h.store.openLoc(ctx, u, e.ClockIn.LocEnc)
		if err != nil {
			return nil, err
		}
		return &loc, nil
	}
	emp, err := h.employers.Get(ctx, *e.EmployerID)
	if err != nil {
		if errors.Is(err, employer.ErrNotFound) {
			return nil, httpx.NotMember()
		}
		return nil, err
	}
	anchor, err := h.employers.DecryptAnchor(ctx, emp)
	if err != nil {
		return nil, err
	}
	return &anchor, nil
}

// anchor returns the employer's clock-in centre, or nil for a personal entry:
// the fix then anchors itself and clock-out is measured against it.
func (h *Handler) anchor(ctx context.Context, employerID *bson.ObjectID, userID bson.ObjectID) (*employer.LatLng, error) {
	if employerID == nil {
		return nil, nil
	}
	if _, err := h.employers.ActiveMembership(ctx, *employerID, userID); err != nil {
		if errors.Is(err, employer.ErrNotFound) {
			return nil, httpx.NotMember()
		}
		return nil, err
	}
	e, err := h.employers.Get(ctx, *employerID)
	if err != nil {
		// An active membership whose employer is gone is not a state a caller can
		// act on either: same answer as no membership, and it confirms nothing.
		if errors.Is(err, employer.ErrNotFound) {
			return nil, httpx.NotMember()
		}
		return nil, err
	}
	anchor, err := h.employers.DecryptAnchor(ctx, e)
	if err != nil {
		return nil, err
	}
	return &anchor, nil
}

// parseEmployerID reads a body field, so a malformed id is a 400 — unlike a path
// parameter, where 404 keeps the endpoint from confirming which ids exist.
func parseEmployerID(hex *string) (*bson.ObjectID, error) {
	if hex == nil || *hex == "" {
		return nil, nil
	}
	id, err := bson.ObjectIDFromHex(*hex)
	if err != nil {
		return nil, httpx.Invalid("employer_id must be an object id")
	}
	return &id, nil
}

func (h *Handler) respond(c echo.Context, status int, u *user.User, e *Entry) error {
	v, err := h.view(c.Request().Context(), u, e)
	if err != nil {
		return err
	}
	return c.JSON(status, echo.Map{"entry": v})
}

func (h *Handler) view(ctx context.Context, u *user.User, e *Entry) (view, error) {
	in, err := h.point(ctx, u, &e.ClockIn)
	if err != nil {
		return view{}, err
	}
	out := view{
		ID:               e.ID,
		ClientID:         e.ClientID,
		EmployerID:       e.EmployerID,
		Status:           e.Status,
		ClockIn:          *in,
		LocationVerified: e.LocationVerified,
		Flags:            e.Flags,
		CreatedAt:        e.CreatedAt,
	}
	if out.Flags == nil {
		out.Flags = []string{}
	}
	if e.ClockOut != nil {
		if out.ClockOut, err = h.point(ctx, u, e.ClockOut); err != nil {
			return view{}, err
		}
	}
	return out, nil
}

func (h *Handler) point(ctx context.Context, u *user.User, p *ClockPoint) (*clockPointView, error) {
	loc, err := h.store.openLoc(ctx, u, p.LocEnc)
	if err != nil {
		return nil, err
	}
	return &clockPointView{At: p.At, Loc: loc, AccuracyM: p.AccuracyM, Mocked: p.Mocked}, nil
}
