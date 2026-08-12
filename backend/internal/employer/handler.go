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

// checkTimezone rejects "" explicitly: LoadLocation resolves it to UTC, which
// would silently accept a client that forgot the field.
func checkTimezone(tz string) error {
	if tz == "" {
		return httpx.Invalid("timezone must not be empty")
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return httpx.Invalid("unknown timezone")
	}
	return nil
}

func checkAnchor(a LatLng) error {
	if a.Lat < -90 || a.Lat > 90 {
		return httpx.Invalid("lat must be within [-90, 90]")
	}
	if a.Lng < -180 || a.Lng > 180 {
		return httpx.Invalid("lng must be within [-180, 180]")
	}
	return nil
}

type createRequest struct {
	Name string `json:"name"`
	// Pointer so a missing anchor is rejected instead of silently anchoring the
	// employer at (0, 0).
	Anchor   *LatLng `json:"anchor"`
	Timezone string  `json:"timezone"`
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
	if req.Anchor == nil {
		return httpx.Invalid("anchor is required")
	}
	if err := checkAnchor(*req.Anchor); err != nil {
		return err
	}

	e, err := h.store.Create(c.Request().Context(), user.CurrentUser(c).ID, name, req.Timezone, *req.Anchor)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, echo.Map{"employer": newView(e, *req.Anchor)})
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
	Name     *string `json:"name"`
	Anchor   *LatLng `json:"anchor"`
	Timezone *string `json:"timezone"`
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
	if req.Anchor != nil {
		if err := checkAnchor(*req.Anchor); err != nil {
			return err
		}
	}

	ctx := c.Request().Context()
	ownerID := user.CurrentUser(c).ID
	if err := h.store.Update(ctx, id, ownerID, name, req.Timezone, req.Anchor); err != nil {
		return mapNotFound(err)
	}
	e, err := h.store.GetOwned(ctx, id, ownerID)
	if err != nil {
		return mapNotFound(err)
	}
	anchor, err := h.store.DecryptAnchor(ctx, e)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, echo.Map{"employer": newView(e, anchor)})
}

func mapNotFound(err error) error {
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	return err
}
