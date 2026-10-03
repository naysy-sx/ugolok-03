// push-bridge-server — мост между relay (путь записи strfry, П0.3 решение Б)
// и ntfy. ТЗ: PROCESS-DOCS/NATIVE-APPS/TZ-PUSH-ANDROID.md, П1.2.
//
// Два входа:
//   - /push/register (POST/PUT/DELETE) — наружу через Caddy, NIP-98 (ИП4).
//   - /internal/event (POST) — только от плагина strfry на этом хосте,
//     Bearer-токен (agent/internal/auth, тот же примитив, что и остальной код).
//
// Секреты и адреса живут в переменных окружения — тот же паттерн, что у
// turncreds-server (agent/cmd/turncreds-server/main.go): деплой кладёт их в
// gitignored .env файл, здесь — только чтение и валидация на старте.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"ugolok.tech/agent/internal/auth"
	"ugolok.tech/agent/internal/pushbridge"
)

const defaultListenAddr = "0.0.0.0:8091"
const defaultDBPath = "/app/data/push.db"
const defaultHourlyCap = 60

func main() {
	dbPath := os.Getenv("PUSH_DB_PATH")
	if dbPath == "" {
		dbPath = defaultDBPath
	}

	internalTokenHex := os.Getenv("PUSH_INTERNAL_TOKEN")
	if internalTokenHex == "" {
		log.Fatal("push-bridge-server: PUSH_INTERNAL_TOKEN пуст — процесс не стартует")
	}
	internalToken, err := auth.DecodeToken(internalTokenHex)
	if err != nil {
		log.Fatalf("push-bridge-server: PUSH_INTERNAL_TOKEN некорректен: %v", err)
	}

	ntfyBaseURL := os.Getenv("PUSH_NTFY_BASE_URL")
	if ntfyBaseURL == "" {
		log.Fatal("push-bridge-server: PUSH_NTFY_BASE_URL пуст — процесс не стартует")
	}
	ntfyToken := os.Getenv("PUSH_NTFY_TOKEN")
	if ntfyToken == "" {
		log.Fatal("push-bridge-server: PUSH_NTFY_TOKEN пуст — процесс не стартует")
	}

	registerURL := os.Getenv("PUSH_REGISTER_URL")
	if registerURL == "" {
		log.Fatal("push-bridge-server: PUSH_REGISTER_URL пуст (внешний URL для сверки тега u NIP-98) — процесс не стартует")
	}
	publicTopicPrefix := os.Getenv("PUSH_PUBLIC_TOPIC_PREFIX")
	if publicTopicPrefix == "" {
		log.Fatal("push-bridge-server: PUSH_PUBLIC_TOPIC_PREFIX пуст — процесс не стартует")
	}

	hourlyCap := defaultHourlyCap
	if raw := os.Getenv("PUSH_HOURLY_CAP"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil {
			log.Fatalf("push-bridge-server: PUSH_HOURLY_CAP=%q некорректен: %v", raw, err)
		}
		hourlyCap = v
	}

	addr := os.Getenv("PUSH_LISTEN")
	if addr == "" {
		addr = defaultListenAddr
	}

	// Тот же набор origin'ов и тот же приём переопределения, что у
	// turncreds-server (agent/cmd/turncreds-server/main.go) — тот же класс
	// проблемы (нативная оболочка грузит страницу со своего, не ugolok.tech,
	// origin), найден здесь позже и независимо, см. комментарий у
	// handleRegister (pushbridge/server.go).
	allowedOrigins := map[string]bool{
		"https://ugolok.tech":      true,
		"https://test.ugolok.tech": true,
		"tauri://localhost":        true,
		"http://tauri.localhost":   true,
		"https://tauri.localhost":  true,
		"https://localhost":        true,
	}
	if raw := os.Getenv("PUSH_CORS_ORIGINS"); raw != "" {
		allowedOrigins = parseOrigins(raw)
	}

	store, err := pushbridge.OpenStore(dbPath)
	if err != nil {
		log.Fatalf("push-bridge-server: %v", err)
	}
	defer store.Close()

	coalescer := pushbridge.NewCoalescer(hourlyCap)
	publisher := pushbridge.NewNtfyPublisher(ntfyBaseURL, ntfyToken)
	srv := pushbridge.NewServer(store, coalescer, publisher, internalToken, registerURL, publicTopicPrefix, allowedOrigins)

	go expireLoop(store)

	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("push-bridge-server: слушаю %s", addr)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("push-bridge-server: %v", err)
	}
}

// expireLoop — «истёкшие удаляются» (ТЗ П1.2). Раз в час достаточно: TTL
// регистрации — 30 дней, отставание на порядок меньше TTL не имеет значения.
func expireLoop(store *pushbridge.Store) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		n, err := store.DeleteExpired(ctx, time.Now())
		cancel()
		if err != nil {
			log.Printf("push-bridge-server: очистка истёкших регистраций: %v", err)
			continue
		}
		if n > 0 {
			log.Printf("push-bridge-server: удалено истёкших регистраций: %d", n)
		}
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
