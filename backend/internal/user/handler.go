package user

import (
	"errors"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/httpx"
	"github.com/setthasit/clockit/backend/internal/valkeyx"
)

const contextKey = "clockit.user"

type Handler struct {
	store *Store
}

func NewHandler(store *Store) *Handler {
	return &Handler{store: store}
}

func RegisterRoutes(e *echo.Echo, h *Handler, authMW echo.MiddlewareFunc, vk valkey.Client, cfg config.Config) {
	userMW := Middleware(h.store)
	rateLimit := valkeyx.RateLimit(vk, cfg)
	e.GET("/v1/me", h.GetMe, authMW, userMW)
	// Rate limit before the user middleware: it only needs the identity, and a
	// rejected request must not pay for GetOrCreate's reads and invitation write.
	e.PATCH("/v1/me", h.PatchMe, authMW, rateLimit, userMW)
}

// Middleware resolves the authenticated identity to a user document, creating
// it on first sight (design §4.3). Must run after the auth middleware.
func Middleware(store *Store) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			u, err := store.GetOrCreate(c.Request().Context(), auth.FromContext(c))
			if errors.Is(err, ErrEmailTaken) {
				return httpx.EmailTaken()
			}
			if err != nil {
				return err
			}
			c.Set(contextKey, u)
			return next(c)
		}
	}
}

// CurrentUser panics if Middleware is missing — programmer error, not a runtime condition.
func CurrentUser(c echo.Context) *User {
	return c.Get(contextKey).(*User)
}

type profile struct {
	ID       bson.ObjectID `json:"id"`
	Email    string        `json:"email"`
	Name     string        `json:"name"`
	HasPhone bool          `json:"has_phone"`
}

// newProfile drops everything a client must never see: the wrapped DEK and the
// phone number itself, which is reduced to its presence.
func newProfile(u *User) profile {
	return profile{ID: u.ID, Email: u.Email, Name: u.Name, HasPhone: len(u.PhoneEnc) > 0}
}

func (h *Handler) GetMe(c echo.Context) error {
	u := CurrentUser(c)
	memberships, err := h.store.ActiveMemberships(c.Request().Context(), u.ID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, echo.Map{"user": newProfile(u), "memberships": memberships})
}

type patchMeRequest struct {
	Name  *string `json:"name"`
	Phone *string `json:"phone"`
}

func (h *Handler) PatchMe(c echo.Context) error {
	var req patchMeRequest
	if err := c.Bind(&req); err != nil {
		return httpx.Invalid("malformed body")
	}
	ctx := c.Request().Context()
	u := CurrentUser(c)

	var name *string
	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed == "" {
			return httpx.Invalid("name must not be empty")
		}
		name = &trimmed
	}

	var phoneEnc []byte
	if req.Phone != nil {
		// ponytail: no way to clear a phone in v1; add a distinct null-vs-empty
		// rule when a client actually needs to remove it.
		phone := strings.TrimSpace(*req.Phone)
		if phone == "" {
			return httpx.Invalid("phone must not be empty")
		}
		dek, err := h.store.env.UnwrapDEK(ctx, u.ID.Hex(), u.DEKWrapped)
		if err != nil {
			return err
		}
		if phoneEnc, err = crypto.SealJSON(dek, phone); err != nil {
			return err
		}
	}

	if err := h.store.Update(ctx, u.ID, name, phoneEnc); err != nil {
		return err
	}
	if name != nil {
		u.Name = *name
	}
	if phoneEnc != nil {
		u.PhoneEnc = phoneEnc
	}
	return c.JSON(http.StatusOK, echo.Map{"user": newProfile(u)})
}
