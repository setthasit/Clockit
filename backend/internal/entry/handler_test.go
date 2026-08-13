package entry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

// Assigning an open entry would re-point its clock-out at the employer's
// anchor, locking a personal shift started out of zone out of ever closing.
// The guard runs before any employer lookup, so a nil employer store also
// proves the request is rejected without one.
func TestAssignRejectsOpenEntry(t *testing.T) {
	ctx := context.Background()
	s, u := testStore(t)
	open, _, err := s.ClockIn(ctx, u, nil, "c-1", testFix())
	if err != nil {
		t.Fatal(err)
	}

	e := echo.New()
	e.HTTPErrorHandler = httpx.ErrorHandler
	body := `{"employer_id":"` + bson.NewObjectID().Hex() + `"}`
	req := httptest.NewRequest(http.MethodPatch, "/v1/entries/"+open.ID.Hex(), strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(open.ID.Hex())
	// The user middleware's key: a mismatch panics in CurrentUser rather than
	// passing quietly.
	c.Set("clockit.user", u)

	if err := NewHandler(s, nil, config.Config{}).Assign(c); err != nil {
		e.HTTPErrorHandler(err, c)
	}
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "INVALID_ARGUMENT") {
		t.Fatalf("status = %d, body = %s, want 400 INVALID_ARGUMENT", rec.Code, rec.Body)
	}

	stored, err := s.ByID(ctx, u.ID, open.ID)
	if err != nil || stored == nil {
		t.Fatalf("ByID = %+v, %v", stored, err)
	}
	if stored.EmployerID != nil || stored.Status != statusOpen {
		t.Fatalf("stored = %+v, want the untouched open personal entry", stored)
	}
}
