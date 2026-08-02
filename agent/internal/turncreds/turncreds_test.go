package turncreds

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"strconv"
	"testing"
	"time"
)

func TestMint_UsernameIsExpiryTimestamp(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	ttl := 12 * time.Hour

	creds := Mint(secret, ttl, now, []string{"turn:example.com:3478"})

	wantUsername := strconv.FormatInt(now.Add(ttl).Unix(), 10)
	if creds.Username != wantUsername {
		t.Fatalf("expected username %q, got %q", wantUsername, creds.Username)
	}
}

func TestMint_PasswordMatchesHMACSHA1Convention(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	ttl := 12 * time.Hour

	creds := Mint(secret, ttl, now, nil)

	mac := hmac.New(sha1.New, secret)
	mac.Write([]byte(creds.Username))
	wantPassword := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	if creds.Password != wantPassword {
		t.Fatalf("password does not match manually computed HMAC-SHA1: got %q, want %q", creds.Password, wantPassword)
	}
}

func TestMint_TTLSecondsMatchesDuration(t *testing.T) {
	creds := Mint([]byte("x"), 12*time.Hour, time.Now(), nil)
	if creds.TTL != 43200 {
		t.Fatalf("expected TTL 43200 seconds (12h), got %d", creds.TTL)
	}
}

func TestMint_URIsPassedThroughUnchanged(t *testing.T) {
	uris := []string{"turn:1.2.3.4:3478", "turns:1.2.3.4:5349"}
	creds := Mint([]byte("x"), time.Hour, time.Now(), uris)
	if len(creds.URIs) != 2 || creds.URIs[0] != uris[0] || creds.URIs[1] != uris[1] {
		t.Fatalf("expected URIs to pass through unchanged, got %v", creds.URIs)
	}
}

func TestMint_DifferentSecretsGiveDifferentPasswords(t *testing.T) {
	now := time.Now()
	a := Mint([]byte("secret-a"), time.Hour, now, nil)
	b := Mint([]byte("secret-b"), time.Hour, now, nil)
	if a.Password == b.Password {
		t.Fatal("different secrets must produce different passwords for the same username")
	}
}

func TestMint_DifferentExpiryGivesDifferentUsernameAndPassword(t *testing.T) {
	secret := []byte("s3cr3t")
	now := time.Now()
	a := Mint(secret, time.Hour, now, nil)
	b := Mint(secret, 2*time.Hour, now, nil)
	if a.Username == b.Username {
		t.Fatal("different TTLs must produce different (expiry-based) usernames")
	}
	if a.Password == b.Password {
		t.Fatal("different usernames must produce different passwords (HMAC depends on message)")
	}
}
