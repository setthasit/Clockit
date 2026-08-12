package user

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
	"github.com/valkey-io/valkey-go"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/httpx"
)

const (
	testAuth0Domain   = "test.auth0.local"
	testAuth0Audience = "https://api.clockit.test"
)

type testAPI struct {
	store   *Store
	handler http.Handler
	key     *rsa.PrivateKey
}

// newTestAPI wires the real route stack — httpx.NewEcho, the auth middleware
// against a local signing key, Mongo and Valkey — so the tests exercise
// middleware order and the error contract, not a hand-assembled subset.
// High enough that no test trips the limiter; the limiter itself is covered in
// valkeyx.
func newTestAPI(t *testing.T) *testAPI {
	t.Helper()
	return newTestAPIWithRateLimit(t, 1000)
}

func newTestAPIWithRateLimit(t *testing.T, perMin int) *testAPI {
	t.Helper()
	addr := os.Getenv("VALKEY_ADDR")
	if addr == "" {
		t.Skip("VALKEY_ADDR not set")
	}
	store := testStore(t)

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
		Auth0Domain:     testAuth0Domain,
		Auth0Audience:   testAuth0Audience,
		RateLimitPerMin: perMin,
	}
	authMW := auth.NewMiddlewareWithKeyfunc(cfg, func(*jwt.Token) (any, error) { return &key.PublicKey, nil })
	e := httpx.NewEcho(cfg)
	RegisterRoutes(e, NewHandler(store), authMW, vk, cfg)
	return &testAPI{store: store, handler: e, key: key}
}

func (a *testAPI) token(t *testing.T, ident auth.Identity) string {
	t.Helper()
	raw, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub":                            ident.Sub,
		"iss":                            "https://" + testAuth0Domain + "/",
		"aud":                            testAuth0Audience,
		"exp":                            time.Now().Add(time.Hour).Unix(),
		"https://clockit/email":          ident.Email,
		"https://clockit/email_verified": ident.EmailVerified,
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

func (a *testAPI) seedEmployer(t *testing.T, name string, anchor Anchor) bson.ObjectID {
	t.Helper()
	ctx := context.Background()
	id := bson.NewObjectID()
	dek, wrapped, err := a.store.env.NewDEK(ctx)
	if err != nil {
		t.Fatal(err)
	}
	anchorEnc, err := crypto.SealJSON(dek, anchor)
	if err != nil {
		t.Fatal(err)
	}
	doc := bson.M{"_id": id, "name": name, "timezone": "Asia/Bangkok",
		"anchor_enc": anchorEnc, "dek_wrapped": wrapped}
	if _, err := a.store.employers.InsertOne(ctx, doc); err != nil {
		t.Fatal(err)
	}
	return id
}

// seedMembership always stores an hourly rate: /v1/me must never echo it back.
func (a *testAPI) seedMembership(t *testing.T, employerID bson.ObjectID, email, status string, userID any) bson.ObjectID {
	t.Helper()
	id := bson.NewObjectID()
	doc := bson.M{"_id": id, "employer_id": employerID, "email": email, "status": status,
		"user_id": userID, "hourly_rate_cents_enc": []byte("sealed rate")}
	if _, err := a.store.memberships.InsertOne(context.Background(), doc); err != nil {
		t.Fatal(err)
	}
	return id
}

type meResponse struct {
	User struct {
		ID       string `json:"id"`
		Email    string `json:"email"`
		Name     string `json:"name"`
		HasPhone bool   `json:"has_phone"`
	} `json:"user"`
	Memberships []struct {
		ID       string `json:"id"`
		Status   string `json:"status"`
		Employer struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Anchor   Anchor `json:"anchor"`
			Timezone string `json:"timezone"`
		} `json:"employer"`
	} `json:"memberships"`
}

func decodeMe(t *testing.T, rec *httptest.ResponseRecorder) meResponse {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
	}
	var got meResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func objectID(t *testing.T, hex string) bson.ObjectID {
	t.Helper()
	id, err := bson.ObjectIDFromHex(hex)
	if err != nil {
		t.Fatalf("id %q: %v", hex, err)
	}
	return id
}

// assertJSONEqual compares whole documents, so an unexpected extra field — a
// leaked hourly rate, a stray membership — fails the test.
func assertJSONEqual(t *testing.T, got []byte, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("got is not JSON: %v (%s)", err, got)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("want is not JSON: %v", err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("body mismatch\n got: %s\nwant: %s", got, want)
	}
}

func uniqueSub(name string) string {
	return fmt.Sprintf("auth0|%s-%d", name, time.Now().UnixNano())
}

func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode string) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status = %d, want %d: %s", rec.Code, wantStatus, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), wantCode) {
		t.Fatalf("body = %s, want code %s", rec.Body, wantCode)
	}
}

func TestGetMeCreatesUserOnceUnderParallelRequests(t *testing.T) {
	api := newTestAPI(t)
	sub := uniqueSub("jit")
	tok := api.token(t, auth.Identity{Sub: sub, Email: "JIT@Example.com"})

	// Without the barrier the first goroutine can finish before the second is
	// scheduled, and the test would pass without ever racing.
	start := make(chan struct{})
	var wg sync.WaitGroup
	recs := make([]*httptest.ResponseRecorder, 2)
	for i := range recs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			recs[i] = api.do(http.MethodGet, "/v1/me", tok, "")
		}()
	}
	close(start)
	wg.Wait()

	first := decodeMe(t, recs[0])
	if second := decodeMe(t, recs[1]); second.User.ID != first.User.ID {
		t.Fatalf("parallel requests returned different users: %s and %s", first.User.ID, second.User.ID)
	}
	if first.User.Email != "jit@example.com" {
		t.Fatalf("email = %q, want lowercased", first.User.Email)
	}

	count, err := api.store.users.CountDocuments(context.Background(), bson.M{"auth0_sub": sub})
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("got %d user docs, want 1", count)
	}
}

func TestGetMeReturnsProfileAndActiveMembershipsOnly(t *testing.T) {
	api := newTestAPI(t)
	email := "shape@example.com"
	// Unverified: invitations are not claimed, so the seeded invited row stays
	// unbound and must not appear in the response.
	tok := api.token(t, auth.Identity{Sub: uniqueSub("shape"), Email: email})
	userID := objectID(t, decodeMe(t, api.do(http.MethodGet, "/v1/me", tok, "")).User.ID)

	anchor := Anchor{Lat: 13.7563, Lng: 100.5018}
	employerID := api.seedEmployer(t, "Acme", anchor)
	membershipID := api.seedMembership(t, employerID, email, "active", userID)
	api.seedMembership(t, api.seedEmployer(t, "Gone", anchor), email, "removed", userID)
	api.seedMembership(t, api.seedEmployer(t, "Pending", anchor), email, "invited", nil)

	rec := api.do(http.MethodGet, "/v1/me", tok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	assertJSONEqual(t, rec.Body.Bytes(), fmt.Sprintf(`{
		"user": {"id": %q, "email": %q, "name": "", "has_phone": false},
		"memberships": [{"id": %q, "status": "active", "employer": {
			"id": %q, "name": "Acme",
			"anchor": {"lat": 13.7563, "lng": 100.5018},
			"timezone": "Asia/Bangkok"}}]
	}`, userID.Hex(), email, membershipID.Hex(), employerID.Hex()))
	if strings.Contains(rec.Body.String(), "hourly_rate") {
		t.Fatalf("hourly rate leaked into /v1/me: %s", rec.Body)
	}
}

func TestGetMeClaimsInvitationOnlyWhenEmailVerified(t *testing.T) {
	api := newTestAPI(t)
	email := "invitee@example.com"
	sub := uniqueSub("claim")
	employerID := api.seedEmployer(t, "Acme", Anchor{Lat: 1, Lng: 2})
	membershipID := api.seedMembership(t, employerID, email, "invited", nil)

	unverified := decodeMe(t, api.do(http.MethodGet, "/v1/me",
		api.token(t, auth.Identity{Sub: sub, Email: email}), ""))
	if len(unverified.Memberships) != 0 {
		t.Fatalf("unverified email saw memberships: %+v", unverified.Memberships)
	}
	assertMembership(t, api.store, membershipID, "invited", nil)

	verified := decodeMe(t, api.do(http.MethodGet, "/v1/me",
		api.token(t, auth.Identity{Sub: sub, Email: email, EmailVerified: true}), ""))
	if len(verified.Memberships) != 1 || verified.Memberships[0].Status != "active" ||
		verified.Memberships[0].Employer.ID != employerID.Hex() {
		t.Fatalf("verified email did not claim the invitation: %+v", verified.Memberships)
	}
	userID := objectID(t, verified.User.ID)
	assertMembership(t, api.store, membershipID, "active", &userID)
}

func TestGetMeRejectsEmailOwnedByAnotherSubject(t *testing.T) {
	api := newTestAPI(t)
	email := "dup@example.com"
	if rec := api.do(http.MethodGet, "/v1/me",
		api.token(t, auth.Identity{Sub: uniqueSub("first"), Email: email}), ""); rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	rec := api.do(http.MethodGet, "/v1/me",
		api.token(t, auth.Identity{Sub: uniqueSub("second"), Email: email}), "")
	assertErrorCode(t, rec, http.StatusConflict, "EMAIL_TAKEN")
}

func TestPatchMeStoresTrimmedNameAndSealedPhone(t *testing.T) {
	api := newTestAPI(t)
	sub := uniqueSub("patch")
	tok := api.token(t, auth.Identity{Sub: sub, Email: "patch@example.com"})
	const phone = "+66811111111"

	rec := api.do(http.MethodPatch, "/v1/me", tok, `{"name":"  Ada  ","phone":"`+phone+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var stored User
	if err := api.store.users.FindOne(context.Background(), bson.M{"auth0_sub": sub}).Decode(&stored); err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, rec.Body.Bytes(), fmt.Sprintf(
		`{"user":{"id":%q,"email":"patch@example.com","name":"Ada","has_phone":true}}`, stored.ID.Hex()))
	if strings.Contains(rec.Body.String(), phone) {
		t.Fatalf("phone echoed back to the client: %s", rec.Body)
	}

	dek, err := api.store.env.UnwrapDEK(context.Background(), stored.ID.Hex(), stored.DEKWrapped)
	if err != nil {
		t.Fatal(err)
	}
	var got string
	if err := crypto.OpenJSON(dek, stored.PhoneEnc, &got); err != nil {
		t.Fatal(err)
	}
	if got != phone {
		t.Fatalf("decrypted phone = %q, want %q", got, phone)
	}
}

func TestPatchMeRejectsInvalidBodies(t *testing.T) {
	api := newTestAPI(t)
	tok := api.token(t, auth.Identity{Sub: uniqueSub("patch-invalid"), Email: "invalid@example.com"})

	for name, body := range map[string]string{
		"empty name":       `{"name":"   "}`,
		"empty phone":      `{"phone":""}`,
		"malformed json":   `{`,
		"wrong field type": `{"name":42}`,
	} {
		t.Run(name, func(t *testing.T) {
			rec := api.do(http.MethodPatch, "/v1/me", tok, body)
			assertErrorCode(t, rec, http.StatusBadRequest, "INVALID_ARGUMENT")
		})
	}
}

// Pins the middleware order auth -> rate limit -> user: a refused request must
// cost neither the JIT provisioning write nor the handler's update.
func TestPatchMeIsRateLimitedBeforeUserProvisioning(t *testing.T) {
	api := newTestAPIWithRateLimit(t, 1)
	sub := uniqueSub("rl")
	tok := api.token(t, auth.Identity{Sub: sub, Email: "rl@example.com"})

	if rec := api.do(http.MethodPatch, "/v1/me", tok, `{"name":"Ada"}`); rec.Code != http.StatusOK {
		t.Fatalf("first request status = %d: %s", rec.Code, rec.Body)
	}
	assertErrorCode(t, api.do(http.MethodPatch, "/v1/me", tok, `{"name":"Bob"}`),
		http.StatusTooManyRequests, "RATE_LIMITED")

	var stored User
	if err := api.store.users.FindOne(context.Background(), bson.M{"auth0_sub": sub}).Decode(&stored); err != nil {
		t.Fatal(err)
	}
	if stored.Name != "Ada" {
		t.Fatalf("name = %q, want Ada — the refused request reached the handler", stored.Name)
	}

	// A budget of zero makes the very first request the refused one, which is
	// the only way to observe that provisioning never ran.
	strict := newTestAPIWithRateLimit(t, 0)
	unseen := uniqueSub("rl-strict")
	assertErrorCode(t, strict.do(http.MethodPatch, "/v1/me",
		strict.token(t, auth.Identity{Sub: unseen, Email: "strict@example.com"}), `{"name":"Zoe"}`),
		http.StatusTooManyRequests, "RATE_LIMITED")

	count, err := strict.store.users.CountDocuments(context.Background(), bson.M{"auth0_sub": unseen})
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("got %d user docs, want 0: provisioning ran before the rate limit", count)
	}
}

func TestPatchMeRejectsOversizedBody(t *testing.T) {
	api := newTestAPI(t)
	tok := api.token(t, auth.Identity{Sub: uniqueSub("patch-big"), Email: "big@example.com"})

	rec := api.do(http.MethodPatch, "/v1/me", tok, `{"name":"`+strings.Repeat("a", 2<<20)+`"}`)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413: %s", rec.Code, rec.Body)
	}
}
