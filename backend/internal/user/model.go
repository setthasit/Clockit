package user

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type User struct {
	ID         bson.ObjectID `bson:"_id,omitempty"`
	Auth0Sub   string        `bson:"auth0_sub"`
	Email      string        `bson:"email"`
	Name       string        `bson:"name"`
	PhoneEnc   []byte        `bson:"phone_enc,omitempty"`
	DEKWrapped []byte        `bson:"dek_wrapped"`
	CreatedAt  time.Time     `bson:"created_at"`
}
