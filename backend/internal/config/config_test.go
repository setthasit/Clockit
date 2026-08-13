package config

import (
	"testing"
	"time"
)

// The queued ceiling must never sit below the freshness rule it widens: the
// `backdated` flag is raised at MAX_CLOCK_SKEW, so a shorter ceiling would leave
// events accepted past it unflagged (design §4.5 rule 3).
func TestLoadRejectsQueuedAgeBelowClockSkew(t *testing.T) {
	cases := []struct {
		name      string
		queuedAge string
		wantErr   bool
	}{
		{"below skew", "4m", true},
		{"equal to skew", "5m", false},
		{"above skew", "72h", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("MONGO_URI", "mongodb://localhost:27017")
			t.Setenv("AUTH0_DOMAIN", "example.auth0.com")
			t.Setenv("AUTH0_AUDIENCE", "https://api.example.com")
			t.Setenv("KEK_MODE", "local")
			t.Setenv("KEK_LOCAL_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
			t.Setenv("MAX_CLOCK_SKEW", "5m")
			t.Setenv("MAX_QUEUED_AGE", tc.queuedAge)

			cfg, err := Load()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("MAX_QUEUED_AGE=%s: got no error, want rejection", tc.queuedAge)
				}
				return
			}
			if err != nil {
				t.Fatalf("MAX_QUEUED_AGE=%s: %v", tc.queuedAge, err)
			}
			if cfg.MaxQueuedAge < 5*time.Minute {
				t.Fatalf("MaxQueuedAge = %v, want >= MaxClockSkew", cfg.MaxQueuedAge)
			}
		})
	}
}
