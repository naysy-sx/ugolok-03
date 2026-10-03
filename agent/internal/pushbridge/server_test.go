package pushbridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const registerURL = "https://relay.ugolok.test/api/push/register"

// mockNtfy — фейковый ntfy: пишет полученные (topic, тело) в канал,
// без сети наружу.
type mockNtfy struct {
	mu    sync.Mutex
	calls []struct {
		topic, auth, body string
	}
	srv *httptest.Server
}

func newMockNtfy(t *testing.T) *mockNtfy {
	m := &mockNtfy{}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := new(bytes.Buffer)
		body.ReadFrom(r.Body)
		m.mu.Lock()
		m.calls = append(m.calls, struct{ topic, auth, body string }{
			topic: r.URL.Path[1:],
			auth:  r.Header.Get("Authorization"),
			body:  body.String(),
		})
		m.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(m.srv.Close)
	return m
}

func (m *mockNtfy) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.calls)
}

func newTestServer(t *testing.T) (*Server, *mockNtfy, []byte) {
	t.Helper()
	store := newTestStore(t)
	coalescer := NewCoalescer(0)
	mock := newMockNtfy(t)
	publisher := NewNtfyPublisher(mock.srv.URL, "ntfy-token")
	internalToken := []byte("0123456789abcdef0123456789abcdef")
	srv := NewServer(store, coalescer, publisher, internalToken, registerURL, "https://relay.ugolok.test/push", map[string]bool{"https://localhost": true})
	return srv, mock, internalToken
}

func signedRegisterRequest(t *testing.T, sk, method string, body []byte) *http.Request {
	t.Helper()
	evt := nostr.Event{
		Kind:      nip98Kind,
		CreatedAt: nostr.Now(),
		Tags:      nostr.Tags{{"u", registerURL}, {"method", method}},
	}
	if err := evt.Sign(sk); err != nil {
		t.Fatalf("sign: %v", err)
	}
	raw, _ := json.Marshal(evt)

	var bodyReader *bytes.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	} else {
		bodyReader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, "/push/register", bodyReader)
	req.Header.Set("Authorization", "Nostr "+base64.StdEncoding.EncodeToString(raw))
	return req
}

func TestHandleRegister_POST_CreatesRegistration(t *testing.T) {
	srv, _, _ := newTestServer(t)
	sk := nostr.GeneratePrivateKey()
	body, _ := json.Marshal(registerRequest{Groups: []string{"g1", "g2"}})

	req := signedRegisterRequest(t, sk, http.MethodPost, body)
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp registerResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Topic == "" || resp.Endpoint == "" || resp.ExpiresAt == 0 {
		t.Fatalf("incomplete response: %+v", resp)
	}

	pub, _ := nostr.GetPublicKey(sk)
	got, err := srv.store.Get(context.Background(), HashPubkey(pub))
	if err != nil {
		t.Fatalf("registration not stored: %v", err)
	}
	if got.Topic != resp.Topic || len(got.Groups) != 2 {
		t.Fatalf("stored registration mismatch: %+v", got)
	}
}

// НАЙДЕНО ЖИВЬЁ (владелец, релизный APK v0.0.1, 2026-10-02) — без этих
// заголовков нативная оболочка (Origin: https://localhost) не могла
// зарегистрироваться вовсе, браузер/WebView блокировал fetch ещё до отправки.
func TestHandleRegister_CORS_AllowedOriginGetsHeader(t *testing.T) {
	srv, _, _ := newTestServer(t)
	sk := nostr.GeneratePrivateKey()
	req := signedRegisterRequest(t, sk, http.MethodPost, nil)
	req.Header.Set("Origin", "https://localhost")
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://localhost" {
		t.Fatalf("Access-Control-Allow-Origin = %q, хотим https://localhost", got)
	}
}

func TestHandleRegister_CORS_UnknownOriginGetsNoHeader(t *testing.T) {
	srv, _, _ := newTestServer(t)
	sk := nostr.GeneratePrivateKey()
	req := signedRegisterRequest(t, sk, http.MethodPost, nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin не должен быть выставлен для чужого origin, получено %q", got)
	}
}

func TestHandleRegister_CORS_PreflightOPTIONS(t *testing.T) {
	srv, _, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/push/register", nil)
	req.Header.Set("Origin", "https://localhost")
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://localhost" {
		t.Fatalf("Access-Control-Allow-Origin = %q, хотим https://localhost", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "POST") || !strings.Contains(got, "DELETE") {
		t.Fatalf("Access-Control-Allow-Methods = %q, хотим POST/PUT/DELETE", got)
	}
}

func TestHandleRegister_PUT_KeepsTopicUpdatesGroups(t *testing.T) {
	srv, _, _ := newTestServer(t)
	sk := nostr.GeneratePrivateKey()

	postBody, _ := json.Marshal(registerRequest{Groups: []string{"g1"}})
	rec1 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec1, signedRegisterRequest(t, sk, http.MethodPost, postBody))
	var created registerResponse
	json.Unmarshal(rec1.Body.Bytes(), &created)

	putBody, _ := json.Marshal(registerRequest{Groups: []string{"g1", "g2", "g3"}})
	rec2 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec2, signedRegisterRequest(t, sk, http.MethodPut, putBody))
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200 on PUT, got %d: %s", rec2.Code, rec2.Body.String())
	}
	var updated registerResponse
	json.Unmarshal(rec2.Body.Bytes(), &updated)

	if updated.Topic != created.Topic {
		t.Fatalf("PUT must keep the same topic: created=%s updated=%s", created.Topic, updated.Topic)
	}

	pub, _ := nostr.GetPublicKey(sk)
	got, _ := srv.store.Get(context.Background(), HashPubkey(pub))
	if len(got.Groups) != 3 {
		t.Fatalf("expected 3 groups after PUT, got %v", got.Groups)
	}
}

func TestHandleRegister_PUT_WithoutPriorRegistration404(t *testing.T) {
	srv, _, _ := newTestServer(t)
	sk := nostr.GeneratePrivateKey()
	body, _ := json.Marshal(registerRequest{Groups: []string{"g1"}})
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, signedRegisterRequest(t, sk, http.MethodPut, body))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestHandleRegister_DELETE_RemovesRegistration(t *testing.T) {
	srv, _, _ := newTestServer(t)
	sk := nostr.GeneratePrivateKey()
	postBody, _ := json.Marshal(registerRequest{})
	rec1 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec1, signedRegisterRequest(t, sk, http.MethodPost, postBody))

	rec2 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec2, signedRegisterRequest(t, sk, http.MethodDelete, nil))
	if rec2.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d: %s", rec2.Code, rec2.Body.String())
	}

	pub, _ := nostr.GetPublicKey(sk)
	if _, err := srv.store.Get(context.Background(), HashPubkey(pub)); err != ErrNotFound {
		t.Fatalf("expected registration gone, got err=%v", err)
	}
}

func TestHandleRegister_ForeignPubkeyCannotDeleteOthers(t *testing.T) {
	srv, _, _ := newTestServer(t)
	owner := nostr.GeneratePrivateKey()
	attacker := nostr.GeneratePrivateKey()

	postBody, _ := json.Marshal(registerRequest{})
	rec1 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec1, signedRegisterRequest(t, owner, http.MethodPost, postBody))

	// ИП4: удалить/поменять регистрацию может только владелец ключа — попытка
	// от другого ключа должна дать 404 (для attacker'а регистрации "не существует"),
	// а НЕ удалить чужую.
	rec2 := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec2, signedRegisterRequest(t, attacker, http.MethodDelete, nil))
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for foreign delete attempt, got %d", rec2.Code)
	}

	ownerPub, _ := nostr.GetPublicKey(owner)
	if _, err := srv.store.Get(context.Background(), HashPubkey(ownerPub)); err != nil {
		t.Fatalf("owner's registration must survive an unrelated attacker's delete: %v", err)
	}
}

// ТЗ П1.2 «мост проверяет: тег p может содержать только pubkey, подписавший
// регистрацию» / П1.5 «чужой pubkey в фильтре p отклоняется». В этой реализации
// требование выполняется структурно, не отдельной валидацией: registerRequest
// не имеет поля для клиентского pubkey/p вообще — получатель личных сообщений
// всегда подразумевается как authenticated-по-NIP-98 ключ (см. комментарий
// пакета store.go). Тест — что попытка протащить такое поле в теле запроса
// (на случай будущего клиента, который решит его прислать) молча игнорируется
// json.Decoder'ом, а не тайно принимается как переопределение получателя.
func TestHandleRegister_ForeignPTagInBodyIsIgnored(t *testing.T) {
	srv, _, _ := newTestServer(t)
	sk := nostr.GeneratePrivateKey()
	body := []byte(`{"groups":["g1"],"p":"someone-elses-pubkey","pubkey":"someone-elses-pubkey"}`)

	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, signedRegisterRequest(t, sk, http.MethodPost, body))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	pub, _ := nostr.GetPublicKey(sk)
	got, err := srv.store.Get(context.Background(), HashPubkey(pub))
	if err != nil {
		t.Fatalf("registration must be stored under the AUTHENTICATED pubkey: %v", err)
	}
	if _, err := srv.store.Get(context.Background(), HashPubkey("someone-elses-pubkey")); err != ErrNotFound {
		t.Fatal("the spoofed pubkey from the body must never become a registration key")
	}
	if len(got.Groups) != 1 {
		t.Fatalf("unexpected groups: %v", got.Groups)
	}
}

func TestHandleRegister_TooManyGroupsRejected(t *testing.T) {
	srv, _, _ := newTestServer(t)
	sk := nostr.GeneratePrivateKey()
	groups := make([]string, MaxGroupsPerRegistration+1)
	for i := range groups {
		groups[i] = "g"
	}
	body, _ := json.Marshal(registerRequest{Groups: groups})
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, signedRegisterRequest(t, sk, http.MethodPost, body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for too many groups, got %d", rec.Code)
	}
}

func TestHandleRegister_InvalidAuthRejected(t *testing.T) {
	srv, _, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/push/register", bytes.NewReader(nil))
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestProcessEvent_PublishesToMatchedTopic(t *testing.T) {
	srv, mock, _ := newTestServer(t)
	ctx := context.Background()
	now := time.Now()
	_ = srv.store.Upsert(ctx, Registration{PubkeyHash: HashPubkey("recipient"), Topic: "topic-1", CreatedAt: now, ExpiresAt: now.Add(time.Hour)})

	err := srv.ProcessEvent(ctx, RelayEvent{Kind: KindGiftWrap, Tags: [][]string{{"p", "recipient"}}})
	if err != nil {
		t.Fatalf("ProcessEvent: %v", err)
	}
	if mock.count() != 1 {
		t.Fatalf("expected 1 ntfy publish call, got %d", mock.count())
	}
}

func TestProcessEvent_NoMatchNoPublish(t *testing.T) {
	srv, mock, _ := newTestServer(t)
	err := srv.ProcessEvent(context.Background(), RelayEvent{Kind: KindGiftWrap, Tags: [][]string{{"p", "nobody"}}})
	if err != nil {
		t.Fatalf("ProcessEvent: %v", err)
	}
	if mock.count() != 0 {
		t.Fatalf("expected 0 publish calls, got %d", mock.count())
	}
}

func TestHandleInternalEvent_RequiresToken(t *testing.T) {
	srv, _, _ := newTestServer(t)
	body, _ := json.Marshal(RelayEvent{Kind: KindGiftWrap, Tags: [][]string{{"p", "x"}}})
	req := httptest.NewRequest(http.MethodPost, "/internal/event", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", rec.Code)
	}
}

func TestHandleInternalEvent_AcceptsAndProcessesAsync(t *testing.T) {
	srv, mock, token := newTestServer(t)
	ctx := context.Background()
	now := time.Now()
	_ = srv.store.Upsert(ctx, Registration{PubkeyHash: HashPubkey("recipient"), Topic: "topic-async", CreatedAt: now, ExpiresAt: now.Add(time.Hour)})

	body, _ := json.Marshal(RelayEvent{Kind: KindGiftWrap, Tags: [][]string{{"p", "recipient"}}})
	req := httptest.NewRequest(http.MethodPost, "/internal/event", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+hex.EncodeToString(token))
	rec := httptest.NewRecorder()

	start := time.Now()
	srv.Routes().ServeHTTP(rec, req)
	elapsed := time.Since(start)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", rec.Code)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("handler must return immediately (async processing), took %v", elapsed)
	}

	deadline := time.Now().Add(2 * time.Second)
	for mock.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if mock.count() != 1 {
		t.Fatalf("expected async publish to have happened, got %d calls", mock.count())
	}
}
