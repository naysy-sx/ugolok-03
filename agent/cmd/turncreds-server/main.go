// turncreds-server — публичный (без аутентификации запроса) HTTP-сервис
// выдачи временных TURN-кредов для официального клиента (ugolok.tech /
// test.ugolok.tech). Не путать с /turn-credentials в agent/internal/httpapi —
// тот приватный, Bearer-token, для сопряжённого self-hosted агента в LAN.
//
// Зачем: статический TURN-пароль в сборке клиента (BUILD_DEFAULT_ICE_SERVERS)
// читает любой посетитель сайта и может гонять чужой трафик через coturn.
// Этот сервис не решает проблему целиком (эндпоинт всё ещё выдаёт креды без
// проверки, кто спрашивает) — но даёт TTL (креды живут час, не вечно),
// ротацию секрета без пересборки клиента и точку для будущей аутентификации
// (NIP-98/подпись nostr-ключом) и rate-limit — см. PROCESS-DOCS/VPS/
// TZ-cicd-hardening.md, этап 6.
package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"ugolok.tech/agent/internal/turncreds"
)

const (
	defaultListenAddr = "127.0.0.1:8090"
	defaultTTLSeconds = 3600
	rateLimitPerHour  = 30
)

// wireResponse — контракт эндпоинта (TZ-cicd-hardening, этап 6.2). Поле
// "credential" (не "password", как в turncreds.Credentials.Password) —
// имя, ожидаемое RTCIceServer на клиенте.
//
// Отступление от буквального текста ТЗ: там пример username — "<expiry>:ugolok"
// (суффикс с именем пользователя). turncreds.Mint (переиспользуется как есть,
// без изменений — см. "Что НЕ делать" в ТЗ) считает HMAC над username БЕЗ
// суффикса; добавить ":ugolok" здесь означало бы разойтись с тем, что подписано,
// и coturn отверг бы креды. coturn's use-auth-secret не требует конкретного
// формата username сверх ведущего unix-timestamp — голый timestamp валиден.
type wireResponse struct {
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
	TTL        int64    `json:"ttl"`
	URIs       []string `json:"uris"`
}

type rateLimiter struct {
	mu      sync.Mutex
	perHour int
	buckets map[string]*bucket
}

type bucket struct {
	windowStart time.Time
	count       int
}

func newRateLimiter(perHour int) *rateLimiter {
	return &rateLimiter{perHour: perHour, buckets: make(map[string]*bucket)}
}

// allow — фиксированное часовое окно на IP (не скользящее) — простой
// счётчик in-memory, без внешних зависимостей (redis и т.п. — не нужны для
// 30 запросов в час на IP).
func (r *rateLimiter) allow(ip string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.buckets[ip]
	if !ok || now.Sub(b.windowStart) >= time.Hour {
		r.buckets[ip] = &bucket{windowStart: now, count: 1}
		return true
	}
	if b.count >= r.perHour {
		return false
	}
	b.count++
	return true
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func defaultURIs() []string {
	return []string{
		"turn:ugolok.tech:3478?transport=udp",
		"turn:ugolok.tech:3478?transport=tcp",
	}
}

func parseOrigins(raw string) map[string]bool {
	out := map[string]bool{}
	for _, o := range strings.Split(raw, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			out[o] = true
		}
	}
	return out
}

func newHandler(secret []byte, ttl time.Duration, uris []string, allowedOrigins map[string]bool, limiter *rateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && allowedOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Cache-Control", "no-store")

		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if !limiter.allow(clientIP(r), time.Now()) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}

		creds := turncreds.Mint(secret, ttl, time.Now(), uris)
		resp := wireResponse{
			Username:   creds.Username,
			Credential: creds.Password,
			TTL:        creds.TTL,
			URIs:       creds.URIs,
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			log.Printf("turncreds-server: ошибка записи ответа: %v", err)
		}
	}
}

func main() {
	secret := os.Getenv("TURN_STATIC_AUTH_SECRET")
	if secret == "" {
		log.Fatal("turncreds-server: TURN_STATIC_AUTH_SECRET пуст — процесс не стартует")
	}

	ttlSeconds := defaultTTLSeconds
	if raw := os.Getenv("TURN_CREDENTIALS_TTL_SECONDS"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v <= 0 {
			log.Fatalf("turncreds-server: TURN_CREDENTIALS_TTL_SECONDS=%q некорректен", raw)
		}
		ttlSeconds = v
	}

	uris := defaultURIs()
	if raw := os.Getenv("TURN_URIS"); raw != "" {
		uris = strings.Split(raw, ",")
	}

	allowedOrigins := map[string]bool{
		"https://ugolok.tech":      true,
		"https://test.ugolok.tech": true,
	}
	if raw := os.Getenv("TURN_CORS_ORIGINS"); raw != "" {
		allowedOrigins = parseOrigins(raw)
	}

	addr := os.Getenv("TURN_CREDS_LISTEN")
	if addr == "" {
		addr = defaultListenAddr
	}

	limiter := newRateLimiter(rateLimitPerHour)
	handler := newHandler([]byte(secret), time.Duration(ttlSeconds)*time.Second, uris, allowedOrigins, limiter)

	mux := http.NewServeMux()
	// Оба пути — контракт сервиса сам по себе (этап 6.2 ТЗ) — "/turn-credentials";
	// Caddy (этап 6.3 ТЗ) проксирует "/api/turn-credentials" директивой `handle`
	// (путь при этом НЕ переписывается, в отличие от `handle_path`) — сервис
	// обязан отвечать на оба, иначе один из двух слоёв ТЗ не работает.
	mux.HandleFunc("/turn-credentials", handler)
	mux.HandleFunc("/api/turn-credentials", handler)

	log.Printf("turncreds-server: слушаю %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
