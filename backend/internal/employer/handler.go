package employer

import (
	"errors"
	"net/http"
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
	// A malformed id is answered like a foreign one: 404 either way, so the
	// endpoint never confirms which employer ids exist.
	id, err := bson.ObjectIDFromHex(c.Param("id"))
	if err != nil {
		return httpx.NotFound()
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
		return mapNotFound(err)
	}
	e, err := h.store.GetOwned(ctx, id, ownerID)
	if err != nil {
		return mapNotFound(err)
	}
	stored, err := h.store.DecryptAnchor(ctx, e)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, echo.Map{"employer": newView(e, stored)})
}

func mapNotFound(err error) error {
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	return err
}
