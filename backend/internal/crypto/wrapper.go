package crypto

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"

	kms "cloud.google.com/go/kms/apiv1"
	"cloud.google.com/go/kms/apiv1/kmspb"

	"github.com/setthasit/clockit/backend/internal/config"
)

// KeyWrapper wraps/unwraps 32-byte DEKs. Two real implementations justify the interface (design §9).
type KeyWrapper interface {
	Wrap(ctx context.Context, dek []byte) ([]byte, error)
	Unwrap(ctx context.Context, wrapped []byte) ([]byte, error)
}

func NewKeyWrapper(cfg config.Config) (KeyWrapper, error) {
	switch cfg.KEKMode {
	case "local":
		kek, err := base64.StdEncoding.DecodeString(cfg.KEKLocalKey)
		if err != nil {
			return nil, fmt.Errorf("KEK_LOCAL_KEY: %w", err)
		}
		if len(kek) != 32 {
			return nil, fmt.Errorf("KEK_LOCAL_KEY must be 32 bytes, got %d", len(kek))
		}
		return &localWrapper{kek: kek}, nil
	case "kms":
		client, err := kms.NewKeyManagementClient(context.Background())
		if err != nil {
			return nil, err
		}
		return &kmsWrapper{client: client, keyName: cfg.KMSKeyName}, nil
	default:
		return nil, fmt.Errorf("unknown KEK_MODE %q", cfg.KEKMode)
	}
}

// localWrapper seals DEKs with a static AES-256-GCM key from env (local dev only).
type localWrapper struct{ kek []byte }

func (w *localWrapper) Wrap(_ context.Context, dek []byte) ([]byte, error) {
	gcm, err := newGCM(w.kek)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, dek, nil), nil
}

func (w *localWrapper) Unwrap(_ context.Context, wrapped []byte) ([]byte, error) {
	gcm, err := newGCM(w.kek)
	if err != nil {
		return nil, err
	}
	if len(wrapped) < gcm.NonceSize() {
		return nil, fmt.Errorf("wrapped DEK too short")
	}
	return gcm.Open(nil, wrapped[:gcm.NonceSize()], wrapped[gcm.NonceSize():], nil)
}

type kmsWrapper struct {
	client  *kms.KeyManagementClient
	keyName string
}

func (w *kmsWrapper) Wrap(ctx context.Context, dek []byte) ([]byte, error) {
	resp, err := w.client.Encrypt(ctx, &kmspb.EncryptRequest{Name: w.keyName, Plaintext: dek})
	if err != nil {
		return nil, err
	}
	return resp.GetCiphertext(), nil
}

func (w *kmsWrapper) Unwrap(ctx context.Context, wrapped []byte) ([]byte, error) {
	resp, err := w.client.Decrypt(ctx, &kmspb.DecryptRequest{Name: w.keyName, Ciphertext: wrapped})
	if err != nil {
		return nil, err
	}
	return resp.GetPlaintext(), nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
