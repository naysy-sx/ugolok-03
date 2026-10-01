package pushbridge

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ИП1 «Push-сообщение не содержит ничего, кроме типа (m/c)» — ТЗ П1.5,
// обязательный тест. Проверяем ровно то, что уходит по сети в ntfy: тело —
// один байт типа, ничего больше (ни pubkey, ни id события, ни счётчика).
func TestNtfyPublisher_BodyIsExactlyTheType(t *testing.T) {
	var gotBody string
	var gotAuth string
	var gotTitle string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		gotAuth = r.Header.Get("Authorization")
		gotTitle = r.Header.Get("Title") // ИП1: заголовок с текстом НЕ должен выставляться
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := NewNtfyPublisher(srv.URL, "tok-123")
	if err := p.Publish(context.Background(), "some-topic", PushMessage); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	if gotBody != "m" {
		t.Fatalf("ИП1 violated: body must be exactly the push type, got %q", gotBody)
	}
	if gotAuth != "Bearer tok-123" {
		t.Fatalf("expected bearer token auth, got %q", gotAuth)
	}
	if gotTitle != "" {
		t.Fatalf("ИП1: no Title header expected, got %q", gotTitle)
	}
}

func TestNtfyPublisher_CallTypeBody(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := NewNtfyPublisher(srv.URL, "tok")
	if err := p.Publish(context.Background(), "t", PushCall); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if gotBody != "c" {
		t.Fatalf("expected body \"c\", got %q", gotBody)
	}
}

func TestNtfyPublisher_PublishesToCorrectTopicPath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := NewNtfyPublisher(srv.URL, "tok")
	_ = p.Publish(context.Background(), "my-topic-xyz", PushMessage)
	if gotPath != "/my-topic-xyz" {
		t.Fatalf("expected path /my-topic-xyz, got %q", gotPath)
	}
}

func TestNtfyPublisher_NonOKStatusIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	p := NewNtfyPublisher(srv.URL, "wrong-token")
	if err := p.Publish(context.Background(), "t", PushMessage); err == nil {
		t.Fatal("expected an error for a non-2xx ntfy response")
	}
}
