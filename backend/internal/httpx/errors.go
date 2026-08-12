package httpx

import (
	"errors"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
	"go.opentelemetry.io/otel/trace"
)

type AppError struct {
	Status  int            `json:"-"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *AppError) Error() string { return e.Code + ": " + e.Message }

// ErrorHandler renders the error contract {"error":{code,message,details}}.
// Unknown errors become 500 INTERNAL — internals never leak to clients.
func ErrorHandler(err error, c echo.Context) {
	trace.SpanFromContext(c.Request().Context()).RecordError(err)

	var ae *AppError
	if !errors.As(err, &ae) {
		var he *echo.HTTPError
		if errors.As(err, &he) {
			// Echo router errors (404/405/...): keep status, canonical code.
			ae = &AppError{Status: he.Code, Code: statusCode(he.Code), Message: http.StatusText(he.Code)}
		} else {
			ae = &AppError{Status: http.StatusInternalServerError, Code: "INTERNAL", Message: "internal error"}
		}
	}
	if c.Response().Committed {
		return
	}
	if writeErr := c.JSON(ae.Status, map[string]any{"error": ae}); writeErr != nil {
		c.Logger().Error(writeErr)
	}
}

func statusCode(status int) string {
	return strings.ToUpper(strings.ReplaceAll(http.StatusText(status), " ", "_"))
}

func Unauthenticated() *AppError {
	return &AppError{Status: http.StatusUnauthorized, Code: "UNAUTHENTICATED", Message: "invalid or missing credentials"}
}
