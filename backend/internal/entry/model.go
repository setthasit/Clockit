package entry

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const (
	statusOpen   = "open"
	statusClosed = "closed"

	// flagSpeedAnomaly marks a shift whose breadcrumbs imply travel nobody made
	// on foot. Advisory only: the employer reviews it, the API never rejects it.
	flagSpeedAnomaly = "speed_anomaly"
)

// ClockPoint is one end of a shift. LocEnc holds {lat, lng} sealed with the
// *user's* DEK — the employee owns their coordinates, the employer only ever
// sees the verdict (design §4.5).
type ClockPoint struct {
	At        time.Time `bson:"at"`
	LocEnc    []byte    `bson:"loc_enc" json:"-"`
	AccuracyM float64   `bson:"accuracy"`
	Mocked    bool      `bson:"mocked"`
}

// Entry carries sealed coordinates, so it must never be marshalled to a client —
// handlers build a projection instead.
type Entry struct {
	ID         bson.ObjectID  `bson:"_id,omitempty"`
	UserID     bson.ObjectID  `bson:"user_id"`
	EmployerID *bson.ObjectID `bson:"employer_id,omitempty"`
	// ClientID makes clock-in idempotent under the mobile outbox replay;
	// CloseClientID does the same for clock-out on the one entry document.
	ClientID         string      `bson:"client_id"`
	CloseClientID    string      `bson:"close_client_id,omitempty"`
	Status           string      `bson:"status"`
	ClockIn          ClockPoint  `bson:"clock_in"`
	ClockOut         *ClockPoint `bson:"clock_out,omitempty"`
	LocationVerified bool        `bson:"location_verified"`
	Flags            []string    `bson:"flags"`
	CreatedAt        time.Time   `bson:"created_at"`
}

// LocationPing is a mid-shift breadcrumb, sealed with the user's DEK and expired
// by a 90-day TTL index on created_at.
type LocationPing struct {
	ID        bson.ObjectID `bson:"_id,omitempty"`
	EntryID   bson.ObjectID `bson:"entry_id"`
	UserID    bson.ObjectID `bson:"user_id"`
	At        time.Time     `bson:"at"`
	LocEnc    []byte        `bson:"loc_enc" json:"-"`
	CreatedAt time.Time     `bson:"created_at"`
}
