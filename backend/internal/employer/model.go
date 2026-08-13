package employer

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Employer carries the wrapped DEK and the sealed anchor, so it must never be
// marshalled to a client — handlers build a projection instead.
type Employer struct {
	ID          bson.ObjectID `bson:"_id,omitempty"`
	OwnerUserID bson.ObjectID `bson:"owner_user_id"`
	Name        string        `bson:"name"`
	Timezone    string        `bson:"timezone"`
	AnchorEnc   []byte        `bson:"anchor_enc" json:"-"`
	DEKWrapped  []byte        `bson:"dek_wrapped" json:"-"`
	CreatedAt   time.Time     `bson:"created_at"`
}

const (
	statusInvited = "invited"
	statusActive  = "active"
	statusRemoved = "removed"
)

type Membership struct {
	ID                 bson.ObjectID  `bson:"_id,omitempty"`
	EmployerID         bson.ObjectID  `bson:"employer_id"`
	Email              string         `bson:"email"`
	UserID             *bson.ObjectID `bson:"user_id,omitempty"`
	Status             string         `bson:"status"`
	HourlyRateCentsEnc []byte         `bson:"hourly_rate_cents_enc,omitempty"`
	CreatedAt          time.Time      `bson:"created_at"`
}

// Member is the employer-owned projection of a membership: the rate is
// decrypted (the owner set it and design §4.2 allows it on this route only) and
// the linked user's name is joined in. Name is empty and UserID nil until the
// invitation is claimed; UserID is what the payroll report joins time entries
// on.
type Member struct {
	ID              bson.ObjectID  `json:"id"`
	UserID          *bson.ObjectID `json:"user_id"`
	Email           string         `json:"email"`
	Status          string         `json:"status"`
	Name            string         `json:"name"`
	HourlyRateCents *int64         `json:"hourly_rate_cents"`
}

// LatLng is both the JSON body of anchor_enc and the wire shape of an anchor.
type LatLng struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}
