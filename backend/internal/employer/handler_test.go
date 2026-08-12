package employer

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/httpx"
	"github.com/setthasit/clockit/backend/internal/user"
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

const (
	testAuth0Domain   = "test.auth0.local"
	testAuth0Audience = "https://api.clockit.test"
)

type testAPI struct {
	handler http.Handler
	key     *rsa.PrivateKey
}

// newTestAPI wires the real route stack — httpx.NewEcho, the auth middleware
// against a local signing key, Mongo and Valkey — so the tests exercise
// ownership and the error contract through the middleware chain. /v1/me is
// registered alongside because the rate-leak test asserts on its payload.
func newTestAPI(t *testing.T) *testAPI {
	t.Helper()
	addr := os.Getenv("VALKEY_ADDR")
	if addr == "" {
		t.Skip("VALKEY_ADDR not set")
	}
	db, env := testDB(t)

	vk, err := valkey.NewClient(valkey.ClientOption{InitAddress: []string{addr}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Auth0Domain:   testAuth0Domain,
		Auth0Audience: testAuth0Audience,
		// High enough that no test trips the limiter; the limiter itself is
		// covered in valkeyx.
		RateLimitPerMin: 1000,
	}
	authMW := auth.NewMiddlewareWithKeyfunc(cfg, func(*jwt.Token) (any, error) { return &key.PublicKey, nil })
	e := httpx.NewEcho(cfg)
	userStore := user.NewStore(db, env)
	RegisterRoutes(e, NewHandler(NewStore(db, env)), userStore, authMW, vk, cfg)
	user.RegisterRoutes(e, user.NewHandler(userStore), authMW, vk, cfg)
	return &testAPI{handler: e, key: key}
}

// token mints a verified identity; the subject is derived from the address so
// repeated calls for one address are the same person. Every test runs against
// its own database, so the subject need not be unique across tests.
func (a *testAPI) token(t *testing.T, email string) string {
	t.Helper()
	raw, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub":                            "auth0|" + email,
		"iss":                            "https://" + testAuth0Domain + "/",
		"aud":                            testAuth0Audience,
		"exp":                            time.Now().Add(time.Hour).Unix(),
		"https://clockit/email":          email,
		"https://clockit/email_verified": true,
	}).SignedString(a.key)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func (a *testAPI) do(method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, out any) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status = %d, want %d: %s", rec.Code, wantStatus, rec.Body)
	}
	if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
		t.Fatalf("%v (%s)", err, rec.Body)
	}
}

func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode string) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status = %d, want %d: %s", rec.Code, wantStatus, rec.Body)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("%v (%s)", err, rec.Body)
	}
	if body.Error.Code != wantCode {
		t.Fatalf("code = %q, want %q (%s)", body.Error.Code, wantCode, rec.Body)
	}
}

type memberJSON struct {
	ID              string `json:"id"`
	Email           string `json:"email"`
	Status          string `json:"status"`
	Name            string `json:"name"`
	HourlyRateCents *int64 `json:"hourly_rate_cents"`
}

func (a *testAPI) createEmployer(t *testing.T, token, name string) string {
	t.Helper()
	var body struct {
		Employer struct {
			ID string `json:"id"`
		} `json:"employer"`
	}
	decodeBody(t, a.do(http.MethodPost, "/v1/employers", token,
		`{"name":"`+name+`","anchor":{"lat":13.7563,"lng":100.5018},"timezone":"Asia/Bangkok"}`),
		http.StatusCreated, &body)
	return body.Employer.ID
}

func (a *testAPI) addMember(t *testing.T, token, employerID, email string) memberJSON {
	t.Helper()
	var body struct {
		Member memberJSON `json:"member"`
	}
	decodeBody(t, a.do(http.MethodPost, "/v1/employers/"+employerID+"/members", token,
		`{"email":"`+email+`"}`), http.StatusCreated, &body)
	return body.Member
}

func (a *testAPI) members(t *testing.T, token, employerID string) []memberJSON {
	t.Helper()
	var body struct {
		Members []memberJSON `json:"members"`
	}
	decodeBody(t, a.do(http.MethodGet, "/v1/employers/"+employerID+"/members", token, ""),
		http.StatusOK, &body)
	return body.Members
}

func (a *testAPI) onlyMember(t *testing.T, token, employerID string) memberJSON {
	t.Helper()
	members := a.members(t, token, employerID)
	if len(members) != 1 {
		t.Fatalf("got %d members, want 1: %+v", len(members), members)
	}
	return members[0]
}

func (a *testAPI) setRate(t *testing.T, token, employerID, memberID string, cents int64) {
	t.Helper()
	rec := a.do(http.MethodPatch, "/v1/employers/"+employerID+"/members/"+memberID, token,
		`{"hourly_rate_cents":`+strconv.FormatInt(cents, 10)+`}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("set rate: status = %d, want 204: %s", rec.Code, rec.Body)
	}
}

// Ownership failures answer 404, never 403: the endpoints must not confirm
// which employer or membership ids exist.
func TestEmployerScopedRoutesAre404ForNonOwners(t *testing.T) {
	api := newTestAPI(t)
	owner := api.token(t, "owner@example.com")
	employerID := api.createEmployer(t, owner, "Acme")
	memberID := api.addMember(t, owner, employerID, "member@example.com").ID

	stranger := api.token(t, "stranger@example.com")
	base := "/v1/employers/" + employerID
	cases := []struct{ name, method, path, body string }{
		{"patch employer", http.MethodPatch, base, `{"name":"Hijacked"}`},
		{"list members", http.MethodGet, base + "/members", ""},
		{"add member", http.MethodPost, base + "/members", `{"email":"intruder@example.com"}`},
		{"set member rate", http.MethodPatch, base + "/members/" + memberID, `{"hourly_rate_cents":9999}`},
		{"remove member", http.MethodDelete, base + "/members/" + memberID, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assertErrorCode(t, api.do(tc.method, tc.path, stranger, tc.body), http.StatusNotFound, "NOT_FOUND")
		})
	}

	var listed struct {
		Employers []struct {
			Name string `json:"name"`
		} `json:"employers"`
	}
	decodeBody(t, api.do(http.MethodGet, "/v1/employers", stranger, ""), http.StatusOK, &listed)
	if len(listed.Employers) != 0 {
		t.Fatalf("stranger sees employers: %+v", listed.Employers)
	}
	// The rejections must also have been rejected as writes.
	got := api.onlyMember(t, owner, employerID)
	if got.ID != memberID || got.Status != statusInvited || got.HourlyRateCents != nil {
		t.Fatalf("member = %+v, want the untouched invitation", got)
	}
	decodeBody(t, api.do(http.MethodGet, "/v1/employers", owner, ""), http.StatusOK, &listed)
	if len(listed.Employers) != 1 || listed.Employers[0].Name != "Acme" {
		t.Fatalf("employers = %+v, want one named Acme", listed.Employers)
	}
}

// The rate is employer-owned data (design §4.2): the members list may show it,
// the employee's own profile must never carry it.
func TestHourlyRateIsOwnerOnlyAndNeverInMe(t *testing.T) {
	api := newTestAPI(t)
	owner := api.token(t, "boss@example.com")
	employerID := api.createEmployer(t, owner, "Acme")

	const email = "earner@example.com"
	employee := api.token(t, email)
	// Signing in first gives the address a user document, so the invitation is
	// claimed on add and the membership shows up in /v1/me.
	if rec := api.do(http.MethodGet, "/v1/me", employee, ""); rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	memberID := api.addMember(t, owner, employerID, email).ID
	api.setRate(t, owner, employerID, memberID, 2200)

	if got := api.onlyMember(t, owner, employerID); got.HourlyRateCents == nil || *got.HourlyRateCents != 2200 {
		t.Fatalf("member = %+v, want the rate the owner just set", got)
	}

	rec := api.do(http.MethodGet, "/v1/me", employee, "")
	var me struct {
		Memberships []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"memberships"`
	}
	decodeBody(t, rec, http.StatusOK, &me)
	if len(me.Memberships) != 1 || me.Memberships[0].ID != memberID || me.Memberships[0].Status != statusActive {
		t.Fatalf("memberships = %+v, want the active membership %s", me.Memberships, memberID)
	}
	if strings.Contains(rec.Body.String(), "hourly_rate") {
		t.Fatalf("hourly rate leaked into /v1/me: %s", rec.Body)
	}
}

func TestMemberLifecycleAddClaimRemoveReAdd(t *testing.T) {
	api := newTestAPI(t)
	owner := api.token(t, "chef@example.com")
	employerID := api.createEmployer(t, owner, "Acme")

	const email = "dao@example.com"
	employee := api.token(t, email)
	if rec := api.do(http.MethodPatch, "/v1/me", employee, `{"name":"Dao"}`); rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}

	// The address already has a user document, so the invitation is claimed on
	// the spot rather than waiting for the next sign-in.
	added := api.addMember(t, owner, employerID, email)
	if added.Status != statusActive || added.Email != email {
		t.Fatalf("member = %+v, want an active membership for %s", added, email)
	}
	if joined := api.onlyMember(t, owner, employerID); joined.Name != "Dao" {
		t.Fatalf("member = %+v, want the joined user's name", joined)
	}
	api.setRate(t, owner, employerID, added.ID, 1800)

	// Case differences must not create a second membership.
	assertErrorCode(t, api.do(http.MethodPost, "/v1/employers/"+employerID+"/members", owner,
		`{"email":"DAO@Example.com"}`), http.StatusConflict, "ALREADY_MEMBER")

	if rec := api.do(http.MethodDelete, "/v1/employers/"+employerID+"/members/"+added.ID, owner, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("remove: status = %d, want 204: %s", rec.Code, rec.Body)
	}
	if removed := api.onlyMember(t, owner, employerID); removed.Status != statusRemoved {
		t.Fatalf("member = %+v, want status removed", removed)
	}

	// Re-adding revives the same document: same employment relationship, same
	// rate, and no duplicate row.
	revived := api.addMember(t, owner, employerID, email)
	if revived.ID != added.ID || revived.Status != statusActive {
		t.Fatalf("revived = %+v, want %s active", revived, added.ID)
	}
	listed := api.onlyMember(t, owner, employerID)
	if listed.HourlyRateCents == nil || *listed.HourlyRateCents != 1800 {
		t.Fatalf("rate = %v, want 1800 preserved across the removal", listed.HourlyRateCents)
	}
}
