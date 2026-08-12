package employer

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/setthasit/clockit/backend/internal/httpx"
)

// Rejected bodies must fail before the store is touched, so a nil store is
// enough to prove validation — and proves it never reaches Mongo.
func rejects(t *testing.T, method, target, body string) string {
	t.Helper()
	e := echo.New()
	e.HTTPErrorHandler = httpx.ErrorHandler
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	h := NewHandler(nil)
	var err error
	if method == http.MethodPost {
		err = h.Create(c)
	} else {
		c.SetParamNames("id")
		c.SetParamValues(bson.NewObjectID().Hex())
		err = h.Patch(c)
	}
	if err != nil {
		e.HTTPErrorHandler(err, c)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("%s %s: status = %d, want 400 (body %s)", method, body, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "INVALID_ARGUMENT") {
		t.Fatalf("%s %s: body = %s, want INVALID_ARGUMENT", method, body, rec.Body.String())
	}
	return strings.TrimSpace(rec.Body.String())
}

func TestCreateRejectsNonIANATimezone(t *testing.T) {
	for _, tz := range []string{"Local", "", "Mars/Olympus"} {
		body := `{"name":"Acme","anchor":{"lat":13.75,"lng":100.5},"timezone":"` + tz + `"}`
		t.Logf("POST tz=%q -> 400 %s", tz, rejects(t, http.MethodPost, "/v1/employers", body))
	}
}

func TestAnchorRequiresBothCoordinates(t *testing.T) {
	cases := []struct{ method, body string }{
		{http.MethodPost, `{"name":"Acme","timezone":"Asia/Bangkok","anchor":{}}`},
		{http.MethodPost, `{"name":"Acme","timezone":"Asia/Bangkok","anchor":{"lat":41}}`},
		{http.MethodPost, `{"name":"Acme","timezone":"Asia/Bangkok"}`},
		{http.MethodPatch, `{"anchor":{"lat":41}}`},
		{http.MethodPatch, `{"anchor":{}}`},
		{http.MethodPost, `{"name":"Acme","timezone":"Asia/Bangkok","anchor":{"lat":91,"lng":0}}`},
	}
	for _, tc := range cases {
		t.Logf("%s %s -> 400 %s", tc.method, tc.body, rejects(t, tc.method, "/v1/employers", tc.body))
	}
}

// A zero coordinate is a real place (Null Island): it must survive validation.
func TestFullAnchorPasses(t *testing.T) {
	var req createRequest
	if err := json.Unmarshal([]byte(`{"anchor":{"lat":0,"lng":0}}`), &req); err != nil {
		t.Fatal(err)
	}
	got, err := req.Anchor.latLng()
	if err != nil {
		t.Fatal(err)
	}
	if got != (LatLng{Lat: 0, Lng: 0}) {
		t.Fatalf("anchor = %+v", got)
	}
}
