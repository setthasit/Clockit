package entry

import (
	"context"
	"errors"
	"net/http"
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
	l := r.Loc
	if l == nil || l.Lat == nil || l.Lng == nil || l.Accuracy == nil {
		return Fix{}, httpx.Invalid("loc requires lat, lng and accuracy")
	}
	if *l.Lat < -90 || *l.Lat > 90 {
		return Fix{}, httpx.Invalid("lat must be within [-90, 90]")
	}
	if *l.Lng < -180 || *l.Lng > 180 {
		return Fix{}, httpx.Invalid("lng must be within [-180, 180]")
	}
	if *l.Accuracy < 0 {
		return Fix{}, httpx.Invalid("accuracy must not be negative")
	}
	return Fix{Lat: *l.Lat, Lng: *l.Lng, AccuracyM: *l.Accuracy, At: msTime(r.At), Mocked: r.Mocked}, nil
}

func (h *Handler) ClockIn(c echo.Context) error {
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

	ctx := c.Request().Context()
	u := user.CurrentUser(c)

	// Idempotency first: the outbox replays clock-ins, and a replay must return
	// the original entry rather than fail the location rules a second time.
	existing, err := h.store.ByClientID(ctx, u.ID, clientID)
	if err != nil {
		return err
	}
	if existing != nil {
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
		return h.respond(c, http.StatusOK, u, e)
	}
	return h.respond(c, http.StatusCreated, u, e)
}

func (h *Handler) ClockOut(c echo.Context) error {
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

	ctx := c.Request().Context()
	u := user.CurrentUser(c)

	// Idempotency first, same reason as clock-in: a replayed close must return
	// the closed entry rather than fail the location rules a second time.
	closed, err := h.store.ByCloseClientID(ctx, u.ID, clientID)
	if err != nil {
		return err
	}
	if closed != nil {
		return h.respond(c, http.StatusOK, u, closed)
	}

	open, err := h.store.OpenEntry(ctx, u.ID)
	if err != nil {
		return err
	}
	if open == nil {
		return httpx.NoOpenEntry()
	}
	// Cheap ordering check before the crypto and the employer read.
	if !fix.At.After(open.ClockIn.At) {
		return httpx.Invalid("clock-out must be after clock-in")
	}
	anchor, err := h.closeAnchor(ctx, u, open)
	if err != nil {
		return err
	}
	if appErr := ValidateFix(h.cfg, time.Now(), fix, anchor); appErr != nil {
		return appErr
	}

	e, err := h.store.ClockOut(ctx, u, open, clientID, fix)
	if errors.Is(err, ErrEntryNotOpen) {
		// Lost the race to a concurrent close: either it was this same close
		// replayed in parallel, or the shift is genuinely gone.
		if closed, findErr := h.store.ByCloseClientID(ctx, u.ID, clientID); findErr != nil {
			return findErr
		} else if closed != nil {
			return h.respond(c, http.StatusOK, u, closed)
		}
		return httpx.NoOpenEntry()
	}
	if err != nil {
		return err
	}
	// 200, not 201: closing a shift updates the entry created at clock-in.
	return h.respond(c, http.StatusOK, u, e)
}

func (h *Handler) List(c echo.Context) error {
	from, err := timeParam(c, "from")
	if err != nil {
		return err
	}
	to, err := timeParam(c, "to")
	if err != nil {
		return err
	}
	if from != nil && to != nil && to.Before(*from) {
		return httpx.Invalid("from must not be after to")
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
// An open entry has only a clock-in to measure; its eventual clock-out is
// validated against this same anchor, because employer_id is set by then.
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
