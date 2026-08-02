package auth

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestGenerateToken_32Bytes(t *testing.T) {
	token, err := GenerateToken()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(token) != 32 {
		t.Fatalf("expected 32 bytes, got %d", len(token))
	}
}

func TestGenerateToken_NotConstant(t *testing.T) {
	a, err := GenerateToken()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, err := GenerateToken()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	equal := true
	for i := range a {
		if a[i] != b[i] {
			equal = false
			break
		}
	}
	if equal {
		t.Fatal("two independently generated tokens must not be equal (crypto/rand, not a fixed value)")
	}
}

func TestEncodeDecodeToken_RoundTrip(t *testing.T) {
	token, _ := GenerateToken()
	encoded := EncodeToken(token)
	if len(encoded) != 64 {
		t.Fatalf("expected 64 hex chars for 32 bytes, got %d (%q)", len(encoded), encoded)
	}
	decoded, err := DecodeToken(encoded)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(decoded) != string(token) {
		t.Fatal("decoded token does not match original")
	}
}

func TestDecodeToken_WrongLength(t *testing.T) {
	if _, err := DecodeToken("deadbeef"); err == nil {
		t.Fatal("expected error for a hex string decoding to fewer than 32 bytes")
	}
}

func TestDecodeToken_NotHex(t *testing.T) {
	if _, err := DecodeToken("not-hex-at-all-zzz"); err == nil {
		t.Fatal("expected error for invalid hex")
	}
}

func TestConstantTimeEqual_Equal(t *testing.T) {
	a := []byte("exactly-the-same-bytes-32-bytes")
	b := []byte("exactly-the-same-bytes-32-bytes")
	if !ConstantTimeEqual(a, b) {
		t.Fatal("identical byte slices must compare equal")
	}
}

func TestConstantTimeEqual_DifferentContent(t *testing.T) {
	a := []byte("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	b := []byte("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	if ConstantTimeEqual(a, b) {
		t.Fatal("different content must not compare equal")
	}
}

func TestConstantTimeEqual_DifferentLength(t *testing.T) {
	a := []byte("short")
	b := []byte("a much longer byte slice than a")
	if ConstantTimeEqual(a, b) {
		t.Fatal("different-length slices must not compare equal")
	}
}

func TestLoadOrCreateToken_CreatesOnFirstCall(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token.hex")

	if _, err := os.Stat(path); err == nil {
		t.Fatal("precondition: file must not exist yet")
	}

	token, err := LoadOrCreateToken(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(token) != 32 {
		t.Fatalf("expected 32-byte token, got %d", len(token))
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("token file must exist after LoadOrCreateToken: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("expected file permissions 0600, got %o", perm)
	}
}

func TestLoadOrCreateToken_PersistsAcrossCalls(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token.hex")

	first, err := LoadOrCreateToken(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	second, err := LoadOrCreateToken(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(first) != string(second) {
		t.Fatal("second call must return the SAME token persisted by the first call, not regenerate")
	}
}

func TestRequireBearerToken_ValidTokenPasses(t *testing.T) {
	expected, _ := GenerateToken()
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	handler := RequireBearerToken(expected, inner)

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	req.Header.Set("Authorization", "Bearer "+EncodeToken(expected))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("inner handler must be called for a valid token")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestRequireBearerToken_MissingHeaderRejected(t *testing.T) {
	expected, _ := GenerateToken()
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	})
	handler := RequireBearerToken(expected, inner)

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("inner handler must NOT be called without an Authorization header")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestRequireBearerToken_WrongTokenRejected(t *testing.T) {
	expected, _ := GenerateToken()
	wrong, _ := GenerateToken()
	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	})
	handler := RequireBearerToken(expected, inner)

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	req.Header.Set("Authorization", "Bearer "+EncodeToken(wrong))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if called {
		t.Fatal("inner handler must NOT be called for a wrong token")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestRequireBearerToken_MalformedHeaderRejected(t *testing.T) {
	expected, _ := GenerateToken()
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("inner handler must not be called for a malformed header")
	})
	handler := RequireBearerToken(expected, inner)

	for _, malformed := range []string{"Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "Bearer not-valid-hex"} {
		req := httptest.NewRequest(http.MethodGet, "/status", nil)
		req.Header.Set("Authorization", malformed)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("header %q: expected 401, got %d", malformed, rec.Code)
		}
	}
}
