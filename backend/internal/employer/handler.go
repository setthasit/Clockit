package employer

import (
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/httpx"
	"github.com/setthasit/clockit/backend/internal/user"
	"github.com/setthasit/clockit/backend/internal/valkeyx"
)

type Handler struct {
	store *Store
}

func NewHandler(store *Store) *Handler {
	return &Handler{store: store}
}

// RegisterRoutes builds its own user middleware: these routes need the caller's
// user document for ownership, and the middleware is cheap to instantiate.
func RegisterRoutes(e *echo.Echo, h *Handler, userStore *user.Store, authMW echo.MiddlewareFunc, vk valkey.Client, cfg config.Config) {
	userMW := user.Middleware(userStore)
	rateLimit := valkeyx.RateLimit(vk, cfg)
	e.POST("/v1/employers", h.Create, authMW, rateLimit, userMW)
	e.GET("/v1/employers", h.List, authMW, userMW)
	e.PATCH("/v1/employers/:id", h.Patch, authMW, rateLimit, userMW)
	e.POST("/v1/employers/:id/members", h.AddMember, authMW, rateLimit, userMW)
	e.GET("/v1/employers/:id/members", h.ListMembers, authMW, userMW)
	e.PATCH("/v1/employers/:id/members/:mid", h.SetMemberRate, authMW, rateLimit, userMW)
	e.DELETE("/v1/employers/:id/members/:mid", h.RemoveMember, authMW, rateLimit, userMW)
}

// view is the client projection of an employer: the sealed anchor is replaced
// by its plaintext (the owner supplied it) and the wrapped DEK is dropped.
type view struct {
	ID        bson.ObjectID `json:"id"`
	Name      string        `json:"name"`
	Anchor    LatLng        `json:"anchor"`
	Timezone  string        `json:"timezone"`
	CreatedAt time.Time     `json:"created_at"`
}

func newView(e *Employer, anchor LatLng) view {
	return view{ID: e.ID, Name: e.Name, Anchor: anchor, Timezone: e.Timezone, CreatedAt: e.CreatedAt}
}

func cleanName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", httpx.Invalid("name must not be empty")
	}
	return name, nil
}

func checkTimezone(tz string) error {
	// LoadLocation resolves "" to UTC and "Local" to the server's zone; neither is
	// an IANA name a client can have meant.
	if tz == "" || tz == "Local" {
		return httpx.Invalid("timezone must be an IANA name")
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return httpx.Invalid("unknown timezone")
	}
	return nil
}

type anchorBody struct {
	Lat *float64 `json:"lat"`
	Lng *float64 `json:"lng"`
}

// Pointers: an omitted coordinate must not default to 0 — on PATCH that would
// silently overwrite the stored one.
func (a *anchorBody) latLng() (LatLng, error) {
	if a == nil || a.Lat == nil || a.Lng == nil {
		return LatLng{}, httpx.Invalid("anchor requires lat and lng")
	}
	if *a.Lat < -90 || *a.Lat > 90 {
		return LatLng{}, httpx.Invalid("lat must be within [-90, 90]")
	}
	if *a.Lng < -180 || *a.Lng > 180 {
		return LatLng{}, httpx.Invalid("lng must be within [-180, 180]")
	}
	return LatLng{Lat: *a.Lat, Lng: *a.Lng}, nil
}

type createRequest struct {
	Name     string      `json:"name"`
	Anchor   *anchorBody `json:"anchor"`
	Timezone string      `json:"timezone"`
}

func (h *Handler) Create(c echo.Context) error {
	var req createRequest
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	name, err := cleanName(req.Name)
	if err != nil {
		return err
	}
	if err := checkTimezone(req.Timezone); err != nil {
		return err
	}
	anchor, err := req.Anchor.latLng()
	if err != nil {
		return err
	}

	e, err := h.store.Create(c.Request().Context(), user.CurrentUser(c).ID, name, req.Timezone, anchor)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, echo.Map{"employer": newView(e, anchor)})
}

func (h *Handler) List(c echo.Context) error {
	ctx := c.Request().Context()
	employers, err := h.store.ListByOwner(ctx, user.CurrentUser(c).ID)
	if err != nil {
		return err
	}
	out := make([]view, 0, len(employers))
	for i := range employers {
		anchor, err := h.store.DecryptAnchor(ctx, &employers[i])
		if err != nil {
			return err
		}
		out = append(out, newView(&employers[i], anchor))
	}
	return c.JSON(http.StatusOK, echo.Map{"employers": out})
}

type patchRequest struct {
	Name     *string     `json:"name"`
	Anchor   *anchorBody `json:"anchor"`
	Timezone *string     `json:"timezone"`
}

func (h *Handler) Patch(c echo.Context) error {
	id, err := parseID(c, "id")
	if err != nil {
		return err
	}
	var req patchRequest
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}

	var name *string
	if req.Name != nil {
		cleaned, err := cleanName(*req.Name)
		if err != nil {
			return err
		}
		name = &cleaned
	}
	if req.Timezone != nil {
		if err := checkTimezone(*req.Timezone); err != nil {
			return err
		}
	}
	var anchor *LatLng
	if req.Anchor != nil {
		parsed, err := req.Anchor.latLng()
		if err != nil {
			return err
		}
		anchor = &parsed
	}

	ctx := c.Request().Context()
	ownerID := user.CurrentUser(c).ID
	if err := h.store.Update(ctx, id, ownerID, name, req.Timezone, anchor); err != nil {
		return mapStoreError(err)
	}
	e, err := h.store.GetOwned(ctx, id, ownerID)
	if err != nil {
		return mapStoreError(err)
	}
	stored, err := h.store.DecryptAnchor(ctx, e)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, echo.Map{"employer": newView(e, stored)})
}

type addMemberRequest struct {
	Email string `json:"email"`
}

func (h *Handler) AddMember(c echo.Context) error {
	e, err := h.owned(c)
	if err != nil {
		return err
	}
	var req addMemberRequest
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	email, err := cleanEmail(req.Email)
	if err != nil {
		return err
	}
	m, err := h.store.AddMember(c.Request().Context(), e, email)
	if err != nil {
		return mapStoreError(err)
	}
	return c.JSON(http.StatusCreated, echo.Map{"member": m})
}

func (h *Handler) ListMembers(c echo.Context) error {
	e, err := h.owned(c)
	if err != nil {
		return err
	}
	members, err := h.store.ListMembers(c.Request().Context(), e)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, echo.Map{"members": members})
}

type memberRateRequest struct {
	// Pointer: a missing rate is a malformed request, not a request to zero it.
	HourlyRateCents *int64 `json:"hourly_rate_cents"`
}

func (h *Handler) SetMemberRate(c echo.Context) error {
	e, err := h.owned(c)
	if err != nil {
		return err
	}
	mid, err := parseID(c, "mid")
	if err != nil {
		return err
	}
	var req memberRateRequest
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	if req.HourlyRateCents == nil {
		return httpx.Invalid("hourly_rate_cents is required")
	}
	if *req.HourlyRateCents < 0 {
		return httpx.Invalid("hourly_rate_cents must not be negative")
	}
	if err := h.store.SetMemberRate(c.Request().Context(), e, mid, *req.HourlyRateCents); err != nil {
		return mapStoreError(err)
	}
	return c.NoContent(http.StatusNoContent)
}

func (h *Handler) RemoveMember(c echo.Context) error {
	e, err := h.owned(c)
	if err != nil {
		return err
	}
	mid, err := parseID(c, "mid")
	if err != nil {
		return err
	}
	if err := h.store.RemoveMember(c.Request().Context(), e.ID, mid); err != nil {
		return mapStoreError(err)
	}
	return c.NoContent(http.StatusNoContent)
}

func cleanEmail(raw string) (string, error) {
	addr, err := mail.ParseAddress(strings.TrimSpace(raw))
	if err != nil {
		return "", httpx.Invalid("email must be a valid address")
	}
	return strings.ToLower(addr.Address), nil
}

// owned is the authorization gate every employer-scoped route runs first.
func (h *Handler) owned(c echo.Context) (*Employer, error) {
	id, err := parseID(c, "id")
	if err != nil {
		return nil, err
	}
	e, err := h.store.GetOwned(c.Request().Context(), id, user.CurrentUser(c).ID)
	if err != nil {
		return nil, mapStoreError(err)
	}
	return e, nil
}

// parseID answers a malformed id like a foreign one: 404 either way, so the
// endpoint never confirms which ids exist.
func parseID(c echo.Context, param string) (bson.ObjectID, error) {
	id, err := bson.ObjectIDFromHex(c.Param(param))
	if err != nil {
		return bson.ObjectID{}, httpx.NotFound()
	}
	return id, nil
}

func mapStoreError(err error) error {
	switch {
	case errors.Is(err, ErrNotFound):
		return httpx.NotFound()
	case errors.Is(err, ErrAlreadyMember):
		return httpx.AlreadyMember()
	default:
		return err
	}
}
