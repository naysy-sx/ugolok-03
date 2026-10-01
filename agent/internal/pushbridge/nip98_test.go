package pushbridge

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const testURL = "https://relay.ugolok.tech/push/register"

func signedAuthHeader(t *testing.T, sk string, method, url string, createdAt time.Time) string {
	t.Helper()
	evt := nostr.Event{
		Kind:      nip98Kind,
		CreatedAt: nostr.Timestamp(createdAt.Unix()),
		Tags: nostr.Tags{
			{"u", url},
			{"method", method},
		},
		Content: "",
	}
	if err := evt.Sign(sk); err != nil {
		t.Fatalf("sign: %v", err)
	}
	raw, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return "Nostr " + base64.StdEncoding.EncodeToString(raw)
}

func newSignedRequest(t *testing.T, method, url string, createdAt time.Time) (*http.Request, string) {
	t.Helper()
	sk := nostr.GeneratePrivateKey()
	pub, err := nostr.GetPublicKey(sk)
	if err != nil {
		t.Fatalf("pubkey: %v", err)
	}
	req := httptest.NewRequest(method, url, nil)
	req.Header.Set("Authorization", signedAuthHeader(t, sk, method, url, createdAt))
	return req, pub
}

func TestVerifyNIP98_ValidPasses(t *testing.T) {
	req, wantPub := newSignedRequest(t, http.MethodPost, testURL, time.Now())
	pub, err := VerifyNIP98(req, testURL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pub != wantPub {
		t.Fatalf("pubkey mismatch: got %s want %s", pub, wantPub)
	}
}

func TestVerifyNIP98_MissingHeader(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, testURL, nil)
	if _, err := VerifyNIP98(req, testURL); err == nil {
		t.Fatal("expected error for missing Authorization header")
	}
}

func TestVerifyNIP98_WrongURL(t *testing.T) {
	req, _ := newSignedRequest(t, http.MethodPost, testURL, time.Now())
	if _, err := VerifyNIP98(req, "https://relay.ugolok.tech/push/register/other"); err == nil {
		t.Fatal("expected error for URL not matching u tag")
	}
}

func TestVerifyNIP98_WrongMethod(t *testing.T) {
	req, _ := newSignedRequest(t, http.MethodPost, testURL, time.Now())
	req.Method = http.MethodPut
	if _, err := VerifyNIP98(req, testURL); err == nil {
		t.Fatal("expected error for method not matching method tag")
	}
}

func TestVerifyNIP98_StaleTimestamp(t *testing.T) {
	req, _ := newSignedRequest(t, http.MethodPost, testURL, time.Now().Add(-10*time.Minute))
	if _, err := VerifyNIP98(req, testURL); err == nil {
		t.Fatal("expected error for stale created_at")
	}
}

func TestVerifyNIP98_FutureTimestamp(t *testing.T) {
	req, _ := newSignedRequest(t, http.MethodPost, testURL, time.Now().Add(10*time.Minute))
	if _, err := VerifyNIP98(req, testURL); err == nil {
		t.Fatal("expected error for created_at too far in the future")
	}
}

func TestVerifyNIP98_WrongKind(t *testing.T) {
	sk := nostr.GeneratePrivateKey()
	evt := nostr.Event{
		Kind:      1,
		CreatedAt: nostr.Now(),
		Tags:      nostr.Tags{{"u", testURL}, {"method", http.MethodPost}},
	}
	if err := evt.Sign(sk); err != nil {
		t.Fatalf("sign: %v", err)
	}
	raw, _ := json.Marshal(evt)
	req := httptest.NewRequest(http.MethodPost, testURL, nil)
	req.Header.Set("Authorization", "Nostr "+base64.StdEncoding.EncodeToString(raw))
	if _, err := VerifyNIP98(req, testURL); err == nil {
		t.Fatal("expected error for wrong kind")
	}
}

func TestVerifyNIP98_TamperedSignature(t *testing.T) {
	req, _ := newSignedRequest(t, http.MethodPost, testURL, time.Now())
	auth := req.Header.Get("Authorization")
	raw, _ := base64.StdEncoding.DecodeString(auth[len("Nostr "):])
	var evt nostr.Event
	_ = json.Unmarshal(raw, &evt)
	evt.PubKey = nostr.GeneratePrivateKey() // произвольное чужое значение, испортит подпись
	tampered, _ := json.Marshal(evt)
	req.Header.Set("Authorization", "Nostr "+base64.StdEncoding.EncodeToString(tampered))
	if _, err := VerifyNIP98(req, testURL); err == nil {
		t.Fatal("expected error for tampered pubkey/signature mismatch")
	}
}

func TestHashPubkey_Deterministic(t *testing.T) {
	a := HashPubkey("abcDEF123")
	b := HashPubkey("abcdef123")
	if a != b {
		t.Fatal("HashPubkey must be case-insensitive/deterministic for the same key")
	}
	c := HashPubkey("different")
	if a == c {
		t.Fatal("different pubkeys must not collide")
	}
}
