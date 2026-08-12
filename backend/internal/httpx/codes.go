package httpx

import (
	"fmt"
	"math"
	"net/http"
)

// Error catalog for the v1 API. Clients key UX off Code — never change a code
// string without updating both frontends.

func Unauthenticated() *AppError {
	return &AppError{Status: http.StatusUnauthorized, Code: "UNAUTHENTICATED", Message: "invalid or missing credentials"}
}

func NotFound() *AppError {
	return &AppError{Status: http.StatusNotFound, Code: "NOT_FOUND", Message: "not found"}
}

func Invalid(msg string) *AppError {
	return &AppError{Status: http.StatusBadRequest, Code: "INVALID_ARGUMENT", Message: msg}
}

func MockedLocation() *AppError {
	return &AppError{Status: http.StatusUnprocessableEntity, Code: "MOCKED_LOCATION", Message: "mock location detected"}
}

func LowAccuracy() *AppError {
	return &AppError{Status: http.StatusUnprocessableEntity, Code: "LOW_ACCURACY", Message: "GPS accuracy too low — move outdoors or enable precise location"}
}

func StaleTimestamp() *AppError {
	return &AppError{Status: http.StatusUnprocessableEntity, Code: "STALE_TIMESTAMP", Message: "location fix too old"}
}

// OutOfRange reports meters as integers: sub-meter precision is noise to a
// human reading "1800 m from anchor", and leaks nothing extra.
func OutOfRange(distanceM, limitM float64) *AppError {
	distance, limit := int(math.Round(distanceM)), int(math.Round(limitM))
	return &AppError{
		Status:  http.StatusUnprocessableEntity,
		Code:    "OUT_OF_RANGE",
		Message: fmt.Sprintf("%d m from anchor (limit %d m)", distance, limit),
		Details: map[string]any{"distance_m": distance, "limit_m": limit},
	}
}

func OpenEntryExists() *AppError {
	return &AppError{Status: http.StatusConflict, Code: "OPEN_ENTRY_EXISTS", Message: "an open entry already exists"}
}

func NoOpenEntry() *AppError {
	return &AppError{Status: http.StatusConflict, Code: "NO_OPEN_ENTRY", Message: "no open entry"}
}

func EmailNotVerified() *AppError {
	return &AppError{Status: http.StatusForbidden, Code: "EMAIL_NOT_VERIFIED", Message: "email not verified"}
}

func RateLimited() *AppError {
	return &AppError{Status: http.StatusTooManyRequests, Code: "RATE_LIMITED", Message: "too many requests"}
}

func AlreadyMember() *AppError {
	return &AppError{Status: http.StatusConflict, Code: "ALREADY_MEMBER", Message: "already a member of this employer"}
}

func NotMember() *AppError {
	return &AppError{Status: http.StatusForbidden, Code: "NOT_MEMBER", Message: "not a member of this employer"}
}
