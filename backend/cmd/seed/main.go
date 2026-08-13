// Command seed fills a local Mongo with one employer's worth of believable
// history so the web and mobile clients have something to render before anyone
// has clocked in for real.
//
// Every document it writes carries `seed: true`, and every run deletes those
// documents first — so re-running replaces the fixture instead of stacking a
// second copy of it. Never point -owner-sub at a real account: the marker makes
// that user's document seed-owned, and the next run deletes it.
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
	// Anchor: downtown Vancouver. Shift fixes sit a few dozen metres off it,
	// well inside the default 1 km radius.
	anchorLat, anchorLng = 49.2827, -123.1207
	accuracyM            = 12.0

	// The three anomalies design §4.5 wants visible in the employer UI, pinned
	// to the first employee's day N so the fixture is the same every run.
	spannerDaysAgo    = 3
	unverifiedDaysAgo = 5
	anomalyDaysAgo    = 6

	seededDays = 7
)

var seedCollections = []string{"users", "employers", "memberships", "time_entries", "location_pings", "tips"}

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
	if err := purge(ctx, db); err != nil {
		return err
	}

	users := user.NewStore(db, env)
	employers := employer.NewStore(db, env)
	entries := entry.NewStore(db, env)
	tips := tip.NewStore(db)

	owner, err := ensureUser(ctx, users, ownerSub, ownerEmail)
	if err != nil {
		return err
	}
	emp, err := employers.Create(ctx, owner.ID, employerName, timezone, employer.LatLng{Lat: anchorLat, Lng: anchorLng})
	if err != nil {
		return err
	}

	staff, err := ensureStaff(ctx, users, employers, emp, employeeEmails)
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
	if err := stamp(ctx, db, emp.ID, append(userIDs(staff), owner.ID)); err != nil {
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

func userIDs(staff []employee) []bson.ObjectID {
	ids := make([]bson.ObjectID, 0, len(staff))
	for _, e := range staff {
		ids = append(ids, e.user.ID)
	}
	return ids
}

func purge(ctx context.Context, db *mongo.Database) error {
	for _, name := range seedCollections {
		if _, err := db.Collection(name).DeleteMany(ctx, bson.M{"seed": true}); err != nil {
			return fmt.Errorf("purge %s: %w", name, err)
		}
	}
	return nil
}

// stamp marks everything this run created. The stores own their document shapes
// and have no business knowing about fixtures, so the marker is added afterwards
// rather than threaded through their signatures.
func stamp(ctx context.Context, db *mongo.Database, employerID bson.ObjectID, users []bson.ObjectID) error {
	owned := bson.M{"employer_id": employerID}
	targets := map[string]bson.M{
		"users":        {"_id": bson.M{"$in": users}},
		"employers":    {"_id": employerID},
		"memberships":  owned,
		"time_entries": owned,
		"tips":         owned,
	}
	for name, filter := range targets {
		if _, err := db.Collection(name).UpdateMany(ctx, filter, bson.M{"$set": bson.M{"seed": true}}); err != nil {
			return fmt.Errorf("stamp %s: %w", name, err)
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

// ensureStaff creates each employee's user before inviting them, which lets
// AddMember's immediate-claim path land the membership straight in "active" —
// the state the calendar and the report both need.
func ensureStaff(ctx context.Context, users *user.Store, employers *employer.Store, emp *employer.Employer, emails []string) ([]employee, error) {
	staff := make([]employee, 0, len(emails))
	for i, email := range emails {
		email = strings.ToLower(email)
		u, err := ensureUser(ctx, users, "seed|"+localPart(email), email)
		if err != nil {
			return nil, err
		}
		m, err := employers.AddMember(ctx, emp, email)
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
			s, err := seedShift(ctx, db, entries, emp, e, i, daysAgo, today, loc)
			if err != nil {
				return nil, err
			}
			out = append(out, *s)
		}
	}
	return out, nil
}

func seedShift(ctx context.Context, db *mongo.Database, entries *entry.Store, emp *employer.Employer,
	e employee, idx, daysAgo int, today time.Time, loc *time.Location,
) (*shift, error) {
	hour := 8 + (daysAgo+idx)%3
	minutes := 450 + ((daysAgo+2*idx)%4)*30 // 7.5 h – 9 h
	anomalous := idx == 0
	if anomalous && daysAgo == spannerDaysAgo {
		hour, minutes = 22, 510 // 22:00 → 06:30, the midnight spanner
	}

	y, mo, d := today.Date()
	in := time.Date(y, mo, d-daysAgo, hour, 0, 0, 0, loc)
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
