package crypto

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"

	"github.com/setthasit/clockit/backend/internal/config"
)

const (
	blobVersion  = 0x01
	nonceSize    = 12
	dekTTL       = 15 * time.Minute
	dekCacheMax  = 1024
	dekSizeBytes = 32
)

type Envelope struct {
	wrapper        KeyWrapper
	cache          *dekCache
	unwrapDuration metric.Float64Histogram
}

func NewEnvelope(cfg config.Config) (*Envelope, error) {
	wrapper, err := NewKeyWrapper(cfg)
	if err != nil {
		return nil, err
	}
	hist, err := otel.Meter("clockit/crypto").Float64Histogram(
		"clockit.kms.unwrap.duration",
		metric.WithUnit("s"),
		metric.WithDescription("KEK unwrap latency; DEK cache effectiveness visible as its rate"),
	)
	if err != nil {
		return nil, err
	}
	return &Envelope{wrapper: wrapper, cache: newDEKCache(), unwrapDuration: hist}, nil
}

// NewDEK generates a random 32-byte DEK and returns it with its wrapped form.
func (e *Envelope) NewDEK(ctx context.Context) (dek, wrapped []byte, err error) {
	dek = make([]byte, dekSizeBytes)
	if _, err = rand.Read(dek); err != nil {
		return nil, nil, err
	}
	if wrapped, err = e.wrapper.Wrap(ctx, dek); err != nil {
		return nil, nil, err
	}
	return dek, wrapped, nil
}

// UnwrapDEK returns the DEK for cacheKey (tenant doc ID hex), cache-aside.
func (e *Envelope) UnwrapDEK(ctx context.Context, cacheKey string, wrapped []byte) ([]byte, error) {
	if dek, ok := e.cache.get(cacheKey); ok {
		return dek, nil
	}
	start := time.Now()
	dek, err := e.wrapper.Unwrap(ctx, wrapped)
	e.unwrapDuration.Record(ctx, time.Since(start).Seconds())
	if err != nil {
		return nil, err
	}
	e.cache.put(cacheKey, dek)
	return dek, nil
}

// Seal encrypts plaintext with the DEK: 0x01 || 12B nonce || ciphertext (GCM).
func Seal(dek, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(dek)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := make([]byte, 0, 1+nonceSize+len(plaintext)+gcm.Overhead())
	out = append(out, blobVersion)
	out = append(out, nonce...)
	return gcm.Seal(out, nonce, plaintext, nil), nil
}

// Open decrypts a Seal blob; rejects unknown version bytes and malformed blobs.
func Open(dek, blob []byte) ([]byte, error) {
	if len(blob) < 1+nonceSize {
		return nil, fmt.Errorf("ciphertext blob too short")
	}
	if blob[0] != blobVersion {
		return nil, fmt.Errorf("unknown ciphertext version 0x%02x", blob[0])
	}
	gcm, err := newGCM(dek)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, blob[1:1+nonceSize], blob[1+nonceSize:], nil)
}

func SealJSON(dek []byte, v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return Seal(dek, b)
}

func OpenJSON(dek, blob []byte, v any) error {
	b, err := Open(dek, blob)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// ponytail: plain map+mutex; LRU lib if entries ever matter
type dekCache struct {
	mu      sync.Mutex
	entries map[string]dekEntry
}

type dekEntry struct {
	dek []byte
	exp time.Time
}

func newDEKCache() *dekCache {
	return &dekCache{entries: make(map[string]dekEntry)}
}

func (c *dekCache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(e.exp) {
		delete(c.entries, key)
		return nil, false
	}
	return e.dek, true
}

func (c *dekCache) put(key string, dek []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= dekCacheMax {
		for k := range c.entries { // ponytail: evict arbitrary entry; LRU if cache pressure ever real
			delete(c.entries, k)
			break
		}
	}
	c.entries[key] = dekEntry{dek: dek, exp: time.Now().Add(dekTTL)}
}
