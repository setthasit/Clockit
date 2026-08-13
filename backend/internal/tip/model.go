package tip

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Tip is one employer's pool for one day. Date is the calendar day in the
// employer's timezone, stored as the "YYYY-MM-DD" string the report groups by:
// that layout sorts lexicographically in chronological order, so range queries
// and sorting work on the string without a date type or a timezone round trip.
type Tip struct {
	ID          bson.ObjectID `bson:"_id,omitempty"`
	EmployerID  bson.ObjectID `bson:"employer_id"`
	Date        string        `bson:"date"`
	AmountCents int64         `bson:"amount_cents"`
	CreatedAt   time.Time     `bson:"created_at"`
}

// view is the client projection: which day, how much. The document's identity
// is the (employer, date) pair the caller already knows.
type view struct {
	Date        string `json:"date"`
	AmountCents int64  `json:"amount_cents"`
}
