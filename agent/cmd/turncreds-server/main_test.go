package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testAllowedOrigins() map[string]bool {
	return map[string]bool{"https://ugolok.tech": true, "https://test.ugolok.tech": true}
}

func TestHandler_FormatAndCredentialMatchesHMAC(t *testing.T) {
	secret := []byte("s3cr3t")
	uris := []string{"turn:ugolok.tech:3478?transport=udp", "turn:ugolok.tech:3478?transport=tcp"}
	handler := newHandler(secret, time.Hour, uris, testAllowedOrigins(), newRateLimiter(30))

	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	req.RemoteAddr = "203.0.113.1:5555"
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", rec.Code, rec.Body.String())
	}
	var got wireResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v, body: %s", err, rec.Body.String())
	}
	if got.Username == "" {
		t.Fatal("username пуст")
	}
	if got.TTL != 3600 {
		t.Fatalf("expected ttl 3600, got %d", got.TTL)
	}
	if len(got.URIs) != 2 || got.URIs[0] != uris[0] || got.URIs[1] != uris[1] {
		t.Fatalf("uris не совпадают: %v", got.URIs)
	}

	mac := hmac.New(sha1.New, secret)
	mac.Write([]byte(got.Username))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if got.Credential != want {
		t.Fatalf("credential не соответствует HMAC-SHA1(secret, username): got %q, want %q", got.Credential, want)
	}
}

func TestHandler_CORS_AllowedOriginEchoed(t *testing.T) {
	handler := newHandler([]byte("s"), time.Hour, defaultURIs(), testAllowedOrigins(), newRateLimiter(30))
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	req.RemoteAddr = "203.0.113.2:5555"
	req.Header.Set("Origin", "https://ugolok.tech")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://ugolok.tech" {
		t.Fatalf("expected ACAO echoed for allowed origin, got %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected Cache-Control: no-store, got %q", got)
	}
}

func TestHandler_CORS_UnknownOriginNotEchoed(t *testing.T) {
	handler := newHandler([]byte("s"), time.Hour, defaultURIs(), testAllowedOrigins(), newRateLimiter(30))
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	req.RemoteAddr = "203.0.113.3:5555"
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	handler(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no ACAO for disallowed origin, got %q", got)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("запрос с недопустимым Origin всё равно должен вернуть 200 (браузер сам заблокирует чтение ответа) — got %d", rec.Code)
	}
}

func TestHandler_OPTIONS_Preflight(t *testing.T) {
	handler := newHandler([]byte("s"), time.Hour, defaultURIs(), testAllowedOrigins(), newRateLimiter(30))
	req := httptest.NewRequest(http.MethodOptions, "/turn-credentials", nil)
	req.RemoteAddr = "203.0.113.4:5555"
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 on OPTIONS, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got == "" {
		t.Fatal("expected Access-Control-Allow-Methods on OPTIONS response")
	}
}

func TestHandler_MethodNotAllowed(t *testing.T) {
	handler := newHandler([]byte("s"), time.Hour, defaultURIs(), testAllowedOrigins(), newRateLimiter(30))
	req := httptest.NewRequest(http.MethodPost, "/turn-credentials", nil)
	req.RemoteAddr = "203.0.113.5:5555"
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestHandler_RateLimit_31stRequestSameIPWithinHourIs429(t *testing.T) {
	handler := newHandler([]byte("s"), time.Hour, defaultURIs(), testAllowedOrigins(), newRateLimiter(30))
	for i := 0; i < 30; i++ {
		req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
		req.RemoteAddr = "203.0.113.6:5555"
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("запрос %d: ожидался 200, получен %d", i+1, rec.Code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	req.RemoteAddr = "203.0.113.6:5555"
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("31-й запрос с того же IP: ожидался 429, получен %d", rec.Code)
	}
}

func TestHandler_RateLimit_DifferentIPsNotSharedBucket(t *testing.T) {
	handler := newHandler([]byte("s"), time.Hour, defaultURIs(), testAllowedOrigins(), newRateLimiter(1))
	req1 := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	req1.RemoteAddr = "203.0.113.7:1111"
	rec1 := httptest.NewRecorder()
	handler(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("IP #1 первый запрос: ожидался 200, получен %d", rec1.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	req2.RemoteAddr = "203.0.113.8:2222"
	rec2 := httptest.NewRecorder()
	handler(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("IP #2 первый запрос (разный IP, свой лимит): ожидался 200, получен %d", rec2.Code)
	}
}

func TestHandler_BothPaths_ServeSameHandler(t *testing.T) {
	mux := http.NewServeMux()
	handler := newHandler([]byte("s"), time.Hour, defaultURIs(), testAllowedOrigins(), newRateLimiter(30))
	mux.HandleFunc("/turn-credentials", handler)
	mux.HandleFunc("/api/turn-credentials", handler)

	for _, path := range []string{"/turn-credentials", "/api/turn-credentials"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "203.0.113.9:5555"
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("path %s: ожидался 200, получен %d", path, rec.Code)
		}
	}
}

func TestParseOrigins(t *testing.T) {
	got := parseOrigins("https://a.example, https://b.example,,https://c.example")
	want := map[string]bool{"https://a.example": true, "https://b.example": true, "https://c.example": true}
	if len(got) != len(want) {
		t.Fatalf("expected %d origins, got %d (%v)", len(want), len(got), got)
	}
	for k := range want {
		if !got[k] {
			t.Fatalf("expected origin %q in parsed set", k)
		}
	}
}
