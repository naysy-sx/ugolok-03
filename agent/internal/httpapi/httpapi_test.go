package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ugolok.tech/agent/internal/auth"
)

func TestStatus_AuthorizedRequestReturnsJSON(t *testing.T) {
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	mux := NewServer(token, func() Status {
		return Status{Version: "dev", UptimeSeconds: 42}
	})

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	req.Header.Set("Authorization", "Bearer "+auth.EncodeToken(token))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", rec.Code, rec.Body.String())
	}
	ct := rec.Header().Get("Content-Type")
	if ct != "application/json" && ct != "application/json; charset=utf-8" {
		t.Fatalf("expected JSON content type, got %q", ct)
	}

	var got Status
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("response body is not valid JSON: %v (%s)", err, rec.Body.String())
	}
	if got.Version != "dev" || got.UptimeSeconds != 42 {
		t.Fatalf("unexpected status body: %+v", got)
	}
}

func TestStatus_UnauthorizedWithoutToken(t *testing.T) {
	token, _ := auth.GenerateToken()
	mux := NewServer(token, func() Status { return Status{} })

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestStatus_UnknownPathReturns404(t *testing.T) {
	token, _ := auth.GenerateToken()
	mux := NewServer(token, func() Status { return Status{} })

	req := httptest.NewRequest(http.MethodGet, "/nonexistent", nil)
	req.Header.Set("Authorization", "Bearer "+auth.EncodeToken(token))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestStatus_CallsStatusFnEachRequest(t *testing.T) {
	token, _ := auth.GenerateToken()
	calls := 0
	mux := NewServer(token, func() Status {
		calls++
		return Status{Version: "dev", UptimeSeconds: int64(calls)}
	})

	for i := 1; i <= 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/status", nil)
		req.Header.Set("Authorization", "Bearer "+auth.EncodeToken(token))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)

		var got Status
		json.Unmarshal(rec.Body.Bytes(), &got)
		if got.UptimeSeconds != int64(i) {
			t.Fatalf("call %d: expected UptimeSeconds=%d (fresh statusFn call), got %d", i, i, got.UptimeSeconds)
		}
	}
	if calls != 3 {
		t.Fatalf("expected statusFn called exactly 3 times, got %d", calls)
	}
}
