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
	return Fix{Lat: *l.Lat, Lng: *l.Lng, AccuracyM: *l.Accuracy, At: r.At, Mocked: r.Mocked}, nil
}

func (h *Handler) ClockIn(c echo.Context) error {
	var req clockRequest
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	clientID := strings.TrimSpace(req.ClientID)
	// ponytail: presence and length only; clients send a UUIDv4 and the unique
	// index is what actually has to hold. Parse it as a UUID if a stricter
	// contract ever earns its keep.
	if clientID == "" || len(clientID) > maxClientIDLen {
		return httpx.Invalid("client_id is required")
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
