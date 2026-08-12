package user

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// User carries the wrapped DEK and the sealed phone, so it must never be
// marshalled to a client — handlers build a projection instead.
type User struct {
	ID         bson.ObjectID `bson:"_id,omitempty"`
	Auth0Sub   string        `bson:"auth0_sub"`
	Email      string        `bson:"email"`
	Name       string        `bson:"name"`
	PhoneEnc   []byte        `bson:"phone_enc,omitempty"`
	DEKWrapped []byte        `bson:"dek_wrapped"`
	CreatedAt  time.Time     `bson:"created_at"`
}

// Membership is the /v1/me view of a membership joined with its employer. It is
// safe to marshal: the hourly rate is deliberately absent, and members are
// entitled to the anchor so the app can show live distance before clock-in
// (design §4.2).
type Membership struct {
	ID       bson.ObjectID `json:"id"`
	Status   string        `json:"status"`
	Employer Employer      `json:"employer"`
}

type Employer struct {
	ID       bson.ObjectID `json:"id"`
	Name     string        `json:"name"`
	Anchor   Anchor        `json:"anchor"`
	Timezone string        `json:"timezone"`
}

// Anchor is both the JSON body of an employer's sealed anchor_enc and its wire
// shape.
type Anchor struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}
