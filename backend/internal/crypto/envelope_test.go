package crypto

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"

	"github.com/setthasit/clockit/backend/internal/config"
)

func randKey(t *testing.T) []byte {
	t.Helper()
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		t.Fatal(err)
	}
	return k
}

func TestSealOpenRoundtrip(t *testing.T) {
	dek := randKey(t)
	plaintext := []byte(`{"lat":49.28,"lng":-123.12}`)

	blob, err := Seal(dek, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Open(dek, blob)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("roundtrip mismatch: got %q want %q", got, plaintext)
	}
}

func TestOpenRejects(t *testing.T) {
	dek := randKey(t)
	blob, err := Seal(dek, []byte("payload"))
	if err != nil {
		t.Fatal(err)
	}

	t.Run("flipped ciphertext bit", func(t *testing.T) {
		bad := bytes.Clone(blob)
		bad[len(bad)-1] ^= 0x01
		if _, err := Open(dek, bad); err == nil {
			t.Fatal("want error")
		}
	})
	t.Run("wrong DEK", func(t *testing.T) {
		if _, err := Open(randKey(t), blob); err == nil {
			t.Fatal("want error")
		}
	})
	t.Run("bad version byte", func(t *testing.T) {
		bad := bytes.Clone(blob)
		bad[0] = 0x02
		if _, err := Open(dek, bad); err == nil {
			t.Fatal("want error")
		}
	})
	t.Run("truncated blob", func(t *testing.T) {
		if _, err := Open(dek, blob[:5]); err == nil {
			t.Fatal("want error")
		}
	})
}

func TestSealOpenJSON(t *testing.T) {
	dek := randKey(t)
	in := map[string]float64{"lat": 49.28, "lng": -123.12}

	blob, err := SealJSON(dek, in)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]float64
	if err := OpenJSON(dek, blob, &out); err != nil {
		t.Fatal(err)
	}
	if out["lat"] != in["lat"] || out["lng"] != in["lng"] {
		t.Fatalf("got %v want %v", out, in)
	}
}

func TestLocalWrapperRoundtrip(t *testing.T) {
	kek := randKey(t)
	w := &localWrapper{kek: kek}
	dek := randKey(t)

	wrapped, err := w.Wrap(context.Background(), dek)
	if err != nil {
		t.Fatal(err)
	}
	got, err := w.Unwrap(context.Background(), wrapped)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, dek) {
		t.Fatal("roundtrip mismatch")
	}

	wrong := &localWrapper{kek: randKey(t)}
	if _, err := wrong.Unwrap(context.Background(), wrapped); err == nil {
		t.Fatal("want error with wrong KEK")
	}
}

func TestNewKeyWrapperLocal(t *testing.T) {
	cfg := config.Config{KEKMode: "local", KEKLocalKey: base64.StdEncoding.EncodeToString(randKey(t))}
	if _, err := NewKeyWrapper(cfg); err != nil {
		t.Fatal(err)
	}

	for name, bad := range map[string]config.Config{
		"bad base64":   {KEKMode: "local", KEKLocalKey: "not-base64!!"},
		"wrong size":   {KEKMode: "local", KEKLocalKey: base64.StdEncoding.EncodeToString([]byte("short"))},
		"unknown mode": {KEKMode: "vault"},
	} {
		if _, err := NewKeyWrapper(bad); err == nil {
			t.Fatalf("%s: want error", name)
		}
	}
}

type countingWrapper struct {
	KeyWrapper
	unwraps int
}

func (w *countingWrapper) Unwrap(ctx context.Context, wrapped []byte) ([]byte, error) {
	w.unwraps++
	return w.KeyWrapper.Unwrap(ctx, wrapped)
}

func TestUnwrapDEKCache(t *testing.T) {
	counting := &countingWrapper{KeyWrapper: &localWrapper{kek: randKey(t)}}
	env := &Envelope{wrapper: counting, cache: newDEKCache(), unwrapDuration: noopHistogram(t)}

	dek, wrapped, err := env.NewDEK(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	got1, err := env.UnwrapDEK(context.Background(), "tenant1", wrapped)
	if err != nil {
		t.Fatal(err)
	}
	got2, err := env.UnwrapDEK(context.Background(), "tenant1", wrapped)
	if err != nil {
		t.Fatal(err)
	}
	if counting.unwraps != 1 {
		t.Fatalf("want 1 wrapper unwrap, got %d", counting.unwraps)
	}
	if !bytes.Equal(got1, dek) || !bytes.Equal(got2, dek) {
		t.Fatal("unwrapped DEK mismatch")
	}
}

func noopHistogram(t *testing.T) metric.Float64Histogram {
	t.Helper()
	hist, err := otel.Meter("test").Float64Histogram("test")
	if err != nil {
		t.Fatal(err)
	}
	return hist
}
