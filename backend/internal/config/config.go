package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	HTTPAddr        string
	MongoURI        string
	MongoDB         string
	ValkeyAddr      string
	Auth0Domain     string
	Auth0Audience   string
	KEKMode         string // local | kms
	KEKLocalKey     string // base64 32 bytes
	KMSKeyName      string
	OTelServiceName string
	MaxAccuracyM    int
	MaxClockSkew    time.Duration
	// MaxQueuedAge bounds how far back an offline-queued clock event may be
	// backdated. Hours are money, so a waived freshness rule still needs a
	// ceiling (design §4.5 rule 3, §5.3).
	MaxQueuedAge    time.Duration
	AnchorRadiusM   int
	SpeedAnomalyKMH int
	RateLimitPerMin int
}

func Load() (Config, error) {
	cfg := Config{
		HTTPAddr:        getenv("HTTP_ADDR", ":8080"),
		MongoURI:        os.Getenv("MONGO_URI"),
		MongoDB:         getenv("MONGO_DB", "clockit_local"),
		ValkeyAddr:      getenv("VALKEY_ADDR", "localhost:6379"),
		Auth0Domain:     os.Getenv("AUTH0_DOMAIN"),
		Auth0Audience:   os.Getenv("AUTH0_AUDIENCE"),
		KEKMode:         getenv("KEK_MODE", "local"),
		KEKLocalKey:     os.Getenv("KEK_LOCAL_KEY"),
		KMSKeyName:      os.Getenv("KMS_KEY_NAME"),
		OTelServiceName: getenv("OTEL_SERVICE_NAME", "clockit-api"),
	}

	var err error
	if cfg.MaxAccuracyM, err = getint("MAX_ACCURACY_M", 100); err != nil {
		return Config{}, err
	}
	if cfg.AnchorRadiusM, err = getint("ANCHOR_RADIUS_M", 1000); err != nil {
		return Config{}, err
	}
	if cfg.SpeedAnomalyKMH, err = getint("SPEED_ANOMALY_KMH", 200); err != nil {
		return Config{}, err
	}
	if cfg.RateLimitPerMin, err = getint("RATE_LIMIT_PER_MIN", 30); err != nil {
		return Config{}, err
	}
	if cfg.MaxClockSkew, err = getdur("MAX_CLOCK_SKEW", 5*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.MaxQueuedAge, err = getdur("MAX_QUEUED_AGE", 72*time.Hour); err != nil {
		return Config{}, err
	}

	if cfg.MongoURI == "" {
		return Config{}, fmt.Errorf("MONGO_URI is required")
	}
	if cfg.Auth0Domain == "" {
		return Config{}, fmt.Errorf("AUTH0_DOMAIN is required")
	}
	if cfg.Auth0Audience == "" {
		return Config{}, fmt.Errorf("AUTH0_AUDIENCE is required")
	}
	switch cfg.KEKMode {
	case "local":
		if cfg.KEKLocalKey == "" {
			return Config{}, fmt.Errorf("KEK_LOCAL_KEY is required when KEK_MODE=local")
		}
	case "kms":
		if cfg.KMSKeyName == "" {
			return Config{}, fmt.Errorf("KMS_KEY_NAME is required when KEK_MODE=kms")
		}
	default:
		return Config{}, fmt.Errorf("KEK_MODE must be local or kms, got %q", cfg.KEKMode)
	}
	return cfg, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getint(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return n, nil
}

func getdur(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return d, nil
}
