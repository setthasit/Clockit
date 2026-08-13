// Command seed fills a local Mongo with one employer's worth of believable
// history so the web and mobile clients have something to render before anyone
// has clocked in for real.
//
// Every run deletes what it owns before writing, so re-running replaces the
// fixture instead of stacking a second copy of it. Exactly this is deleted:
// every employer OWNED by -owner-sub and all of that employer's memberships and
// tips, plus all time entries and location pings of the seeded users. Nothing
// else is touched — an employer someone else owns survives a run intact, even
// one a seeded user is a member of. Ownership is read off the documents
// themselves rather than a marker written at the end of a run, so a run
// interrupted halfway still cleans up on the next attempt. Seeded users are
// matched by auth0 sub and reused, never deleted. Never point -owner-sub at a
// real account: every employer that user owns is purged.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/setthasit/clockit/backend/internal/auth"
	"github.com/setthasit/clockit/backend/internal/config"
	"github.com/setthasit/clockit/backend/internal/crypto"
	"github.com/setthasit/clockit/backend/internal/employer"
	"github.com/setthasit/clockit/backend/internal/entry"
	"github.com/setthasit/clockit/backend/internal/mongox"
	"github.com/setthasit/clockit/backend/internal/tip"
	"github.com/setthasit/clockit/backend/internal/user"
)

const (
	employerName = "Acme Cafe"
	timezone     = "America/Vancouver"
	// Anchor: downtown Vancouver. Shift fixes sit up to ~125 m off it with the
	// default two employees, well inside the default 1 km radius.
	anchorLat, anchorLng = 49.2827, -123.1207
	accuracyM            = 12.0

	// The three anomalies design §4.5 wants visible in the employer UI, pinned
	// to the first employee's day N so the fixture is the same every run.
	spannerDaysAgo    = 3
	unverifiedDaysAgo = 5
	anomalyDaysAgo    = 6

	seededDays = 7
)

// tipsByDaysAgo is the pool for three of the seven days; the rest stay untipped
// so the report exercises both branches.
var tipsByDaysAgo = map[int]int64{1: 8000, 3: 12000, 5: 6500}

func main() {
	ownerSub := flag.String("owner-sub", "seed|owner", "auth0 sub for the seeded owner")
	ownerEmail := flag.String("owner-email", "owner@acme.test", "email for the seeded owner")
	employeeEmails := flag.String("employee-emails", "alice@acme.test,bob@acme.test", "comma-separated employee emails")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := run(ctx, *ownerSub, *ownerEmail, splitEmails(*employeeEmails)); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, ownerSub, ownerEmail string, employeeEmails []string) error {
	if len(employeeEmails) == 0 {
		return fmt.Errorf("-employee-emails must list at least one address")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	env, err := crypto.NewEnvelope(cfg)
	if err != nil {
		return err
	}
	client, err := mongo.Connect(options.Client().ApplyURI(cfg.MongoURI))
	if err != nil {
		return err
	}
	defer func() {
		if err := client.Disconnect(context.WithoutCancel(ctx)); err != nil {
			log.Printf("disconnect: %v", err)
		}
	}()
	db := client.Database(cfg.MongoDB)

	// The API creates these on startup, but seeding may well be the first thing
	// a fresh database ever sees, and the fixture leans on the unique indexes.
	if err := mongox.EnsureIndexes(ctx, db); err != nil {
		return err
	}

	users := user.NewStore(db, env)
	employers := employer.NewStore(db, env)
	entries := entry.NewStore(db, env)
	tips := tip.NewStore(db)

	// Users are resolved before the purge because they are what the purge keys
	// off: GetOrCreate is idempotent by auth0 sub, so this reattaches to the
	// users a previous run made and reaches every document hanging off them.
	owner, err := ensureUser(ctx, users, ownerSub, ownerEmail)
	if err != nil {
		return err
	}
	staffUsers, err := ensureUsers(ctx, users, employeeEmails)
	if err != nil {
		return err
	}
	if err := purge(ctx, db, employers, owner.ID, append(userIDs(staffUsers), owner.ID)); err != nil {
		return err
	}

	emp, err := employers.Create(ctx, owner.ID, employerName, timezone, employer.LatLng{Lat: anchorLat, Lng: anchorLng})
	if err != nil {
		return err
	}
	staff, err := addStaff(ctx, employers, emp, staffUsers)
	if err != nil {
		return err
	}
	shifts, err := seedShifts(ctx, db, entries, emp, staff)
	if err != nil {
		return err
	}
	tipDates, err := seedTips(ctx, tips, emp.ID)
	if err != nil {
		return err
	}

	report(emp, staff, shifts, tipDates)
	return nil
}

// employee is a seeded staff member: the user document that owns the shift
// coordinates, plus the membership that carries the rate.
type employee struct {
	user *user.User
	name string
	rate int64
}

func userIDs(users []*user.User) []bson.ObjectID {
	ids := make([]bson.ObjectID, 0, len(users))
	for _, u := range users {
		ids = append(ids, u.ID)
	}
	return ids
}

// purge deletes the previous fixture by the identity this command owns: the
// employers the seeded owner owns, whatever hangs off them, and the seeded
// users' entries. Deleting the entries by user rather than by employer matters —
// an interrupted run can leave an entry whose employer document never made it,
// and a leftover entry is what wedges the next run's ClockIn/ClockOut pair.
//
// Employers are found by ownership only, never by walking back from a seeded
// user's memberships or entries: a seeded employee may also be a member of a
// real employer, and reaching employers through them would delete that
// employer's memberships and tips.
func purge(ctx context.Context, db *mongo.Database, employers *employer.Store, ownerID bson.ObjectID, users []bson.ObjectID) error {
	owned, err := employers.ListByOwner(ctx, ownerID)
	if err != nil {
		return fmt.Errorf("purge: list employers: %w", err)
	}
	employerIDs := make([]bson.ObjectID, 0, len(owned))
	for _, e := range owned {
		employerIDs = append(employerIDs, e.ID)
	}

	byUser := bson.M{"user_id": bson.M{"$in": users}}
	byEmployer := bson.M{"employer_id": bson.M{"$in": employerIDs}}
	targets := []struct {
		name   string
		filter bson.M
	}{
		{"time_entries", byUser},
		{"location_pings", byUser},
		{"memberships", byEmployer},
		{"tips", byEmployer},
		{"employers", bson.M{"owner_user_id": ownerID}},
	}
	for _, t := range targets {
		if _, err := db.Collection(t.name).DeleteMany(ctx, t.filter); err != nil {
			return fmt.Errorf("purge %s: %w", t.name, err)
		}
	}
	return nil
}

// ensureUser provisions through the same JIT path a first login takes, so the
// seeded user is indistinguishable from a real one — DEK included.
func ensureUser(ctx context.Context, users *user.Store, sub, email string) (*user.User, error) {
	email = strings.ToLower(email)
	u, err := users.GetOrCreate(ctx, auth.Identity{Sub: sub, Email: email, EmailVerified: true})
	if err != nil {
		return nil, err
	}
	name := displayName(email)
	if err := users.Update(ctx, u.ID, &name, nil); err != nil {
		return nil, err
	}
	u.Name = name
	return u, nil
}

func ensureUsers(ctx context.Context, users *user.Store, emails []string) ([]*user.User, error) {
	out := make([]*user.User, 0, len(emails))
	for _, email := range emails {
		email = strings.ToLower(email)
		u, err := ensureUser(ctx, users, "seed|"+localPart(email), email)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, nil
}

// addStaff invites employees who already have user documents, which lets
// AddMember's immediate-claim path land the membership straight in "active" —
// the state the calendar and the report both need.
func addStaff(ctx context.Context, employers *employer.Store, emp *employer.Employer, staffUsers []*user.User) ([]employee, error) {
	staff := make([]employee, 0, len(staffUsers))
	for i, u := range staffUsers {
		m, err := employers.AddMember(ctx, emp, u.Email)
		if err != nil {
			return nil, err
		}
		rate := int64(1800)
		if i%2 == 1 {
			rate = 2200
		}
		if err := employers.SetMemberRate(ctx, emp, m.ID, rate); err != nil {
			return nil, err
		}
		staff = append(staff, employee{user: u, name: u.Name, rate: rate})
	}
	return staff, nil
}

// shift is one seeded row, kept for the summary table.
type shift struct {
	date     string
	employee string
	in, out  time.Time
	minutes  int
	verified bool
	flags    []string
}

func seedShifts(ctx context.Context, db *mongo.Database, entries *entry.Store, emp *employer.Employer, staff []employee) ([]shift, error) {
	loc, err := time.LoadLocation(emp.Timezone)
	if err != nil {
		return nil, err
	}
	today := time.Now().In(loc)
	out := make([]shift, 0, seededDays*len(staff))

	// Oldest first: each shift is closed before the next opens, which is what
	// the one-open-entry-per-user index requires.
	for daysAgo := seededDays; daysAgo >= 1; daysAgo-- {
		for i, e := range staff {
			s, err := seedShift(ctx, db, entries, emp, e, i, daysAgo, today)
			if err != nil {
				return nil, err
			}
			out = append(out, *s)
		}
	}
	return out, nil
}

func seedShift(ctx context.Context, db *mongo.Database, entries *entry.Store, emp *employer.Employer,
	e employee, idx, daysAgo int, today time.Time,
) (*shift, error) {
	hour := 8 + (daysAgo+idx)%3
	minutes := 450 + ((daysAgo+2*idx)%4)*30 // 7.5 h – 9 h
	anomalous := idx == 0
	if anomalous && daysAgo == spannerDaysAgo {
		hour, minutes = 22, 510 // 22:00 → 06:30, the midnight spanner
	}

	y, mo, d := today.Date()
	in := time.Date(y, mo, d-daysAgo, hour, 0, 0, 0, today.Location())
	outAt := in.Add(time.Duration(minutes) * time.Minute)
	fix := func(at time.Time) entry.Fix {
		return entry.Fix{
			Lat:       anchorLat + float64(idx)*0.0004 + float64(daysAgo)*0.0001,
			Lng:       anchorLng - float64(idx)*0.0003,
			AccuracyM: accuracyM,
			At:        at,
		}
	}

	clientID := fmt.Sprintf("seed-%s-%d", localPart(e.user.Email), daysAgo)
	created, _, err := entries.ClockIn(ctx, e.user, &emp.ID, clientID, fix(in))
	if err != nil {
		return nil, err
	}
	closed, err := entries.ClockOut(ctx, e.user, created, clientID+"-out", fix(outAt))
	if err != nil {
		return nil, err
	}

	s := shift{
		date:     in.Format(time.DateOnly),
		employee: e.name,
		in:       in,
		out:      outAt,
		minutes:  minutes,
		verified: true,
		flags:    []string{},
	}
	switch {
	case anomalous && daysAgo == unverifiedDaysAgo:
		// The store writes verified entries by construction (the handler ran the
		// anchor rule first), so the "assigned later, out of range" case has to be
		// written straight onto the document.
		if _, err := db.Collection("time_entries").UpdateByID(ctx, closed.ID,
			bson.M{"$set": bson.M{"location_verified": false}}); err != nil {
			return nil, err
		}
		s.verified = false
	case anomalous && daysAgo == anomalyDaysAgo:
		if err := entries.Flag(ctx, closed, "speed_anomaly"); err != nil {
			return nil, err
		}
		s.flags = append(s.flags, "speed_anomaly")
	}
	return &s, nil
}

func seedTips(ctx context.Context, tips *tip.Store, employerID bson.ObjectID) (map[string]int64, error) {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, err
	}
	y, mo, d := time.Now().In(loc).Date()
	out := make(map[string]int64, len(tipsByDaysAgo))
	for daysAgo, cents := range tipsByDaysAgo {
		date := time.Date(y, mo, d-daysAgo, 0, 0, 0, 0, loc).Format(time.DateOnly)
		if err := tips.Upsert(ctx, employerID, date, cents); err != nil {
			return nil, err
		}
		out[date] = cents
	}
	return out, nil
}

func report(emp *employer.Employer, staff []employee, shifts []shift, tipDates map[string]int64) {
	fmt.Printf("\nemployer  %s  %s  (%s, anchor %.4f,%.4f)\n", emp.ID.Hex(), emp.Name, emp.Timezone, anchorLat, anchorLng)
	for _, e := range staff {
		fmt.Printf("member    %-22s %-24s %d¢/h\n", e.name, e.user.Email, e.rate)
	}

	fmt.Printf("\n%-12s %-10s %-7s %-9s %-6s %-8s %s\n", "DATE", "EMPLOYEE", "IN", "OUT", "MIN", "VERIFIED", "FLAGS")
	for _, s := range shifts {
		outAt := s.out.Format("15:04")
		if s.out.Day() != s.in.Day() {
			outAt += " +1d"
		}
		fmt.Printf("%-12s %-10s %-7s %-9s %-6d %-8t %s\n",
			s.date, s.employee, s.in.Format("15:04"), outAt, s.minutes, s.verified, strings.Join(s.flags, ","))
	}

	fmt.Printf("\n%-12s %s\n", "TIP DATE", "AMOUNT")
	for _, s := range shifts {
		if cents, ok := tipDates[s.date]; ok {
			fmt.Printf("%-12s %d¢\n", s.date, cents)
			delete(tipDates, s.date)
		}
	}
	fmt.Println()
}

func splitEmails(csv string) []string {
	out := []string{}
	for _, e := range strings.Split(csv, ",") {
		if e = strings.TrimSpace(e); e != "" {
			out = append(out, e)
		}
	}
	return out
}

func localPart(email string) string {
	local, _, _ := strings.Cut(email, "@")
	return local
}

// displayName is good enough for a fixture: "alice@acme.test" → "Alice".
func displayName(email string) string {
	local := localPart(email)
	if local == "" {
		return email
	}
	return strings.ToUpper(local[:1]) + local[1:]
}
