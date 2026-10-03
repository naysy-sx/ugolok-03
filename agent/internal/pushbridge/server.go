// server.go — HTTP-контракт моста (ТЗ П1.2 «Регистрация», «Слушатель»).
//
// Два разных потребителя, две разные модели доверия:
//   - /push/register — обращается клиент Уголка напрямую, снаружи (через Caddy),
//     авторизация NIP-98 (ИП4 — только владелец ключа).
//   - /internal/event — обращается ТОЛЬКО плагин strfry на этом же хосте
//     (whitelist-plugin.mjs, П0.3 решение (Б)), общий секрет (agent/internal/auth,
//     тот же примитив, что уже использует остальной agent-код). НЕ выставляется
//     наружу через Caddy — если это когда-нибудь пойдёт не так, разница в
//     авторизации (NIP-98 vs Bearer-секрет) — последний рубеж, не единственный.
package pushbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"ugolok.tech/agent/internal/auth"
)

// MaxGroupsPerRegistration — П1.2 «Лимиты на количество записей — разумные».
// MLS-группы одного пользователя на self-hosted острове реально исчисляются
// десятками; 300 — генерous потолок, не бьющий по нормальному использованию,
// но ограничивающий размер запроса/строки БД на порядок ниже того, что могло
// бы быть проблемой (защита не от конкретной атаки, а от неограниченного роста).
const MaxGroupsPerRegistration = 300

type Server struct {
	store          *Store
	coalescer      *Coalescer
	publisher      *NtfyPublisher
	internalAuth   []byte // agent/internal/auth токен для /internal/event
	registerURL    string // точный внешний URL /push/register — сверяется с тегом u (NIP-98)
	publicTopic    string // внешний префикс для поля endpoint в ответе (см. ntfy.go/README)
	allowedOrigins map[string]bool
}

func NewServer(store *Store, coalescer *Coalescer, publisher *NtfyPublisher, internalAuthToken []byte, registerURL, publicTopicPrefix string, allowedOrigins map[string]bool) *Server {
	return &Server{
		store:          store,
		coalescer:      coalescer,
		publisher:      publisher,
		internalAuth:   internalAuthToken,
		registerURL:    registerURL,
		publicTopic:    strings.TrimRight(publicTopicPrefix, "/"),
		allowedOrigins: allowedOrigins,
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/push/register", s.handleRegister)
	mux.HandleFunc("/health", s.handleHealth)
	mux.Handle("/internal/event", auth.RequireBearerToken(s.internalAuth, http.HandlerFunc(s.handleInternalEvent)))
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

type registerRequest struct {
	Groups []string `json:"groups"`
}

type registerResponse struct {
	Endpoint  string `json:"endpoint"`
	Topic     string `json:"topic"`
	ExpiresAt int64  `json:"expires_at"`
}

// НАЙДЕНО ЖИВЬЁ (владелец, релизный APK v0.0.1, 2026-10-02) — нативная
// оболочка грузит страницу не с ugolok.tech, а со своего внутреннего origin
// (https://localhost на Capacitor/Android, tauri://localhost и т.п. на
// десктопе) — тот же класс проблемы, что уже чинили для TURN-кредов
// (turncreds-server/main.go, Э3). Без Access-Control-Allow-Origin браузер/
// WebView блокировал ЛЮБОЙ fetch к /push/register ещё до отправки — кнопка
// "Включить уведомления в фоне" в настройках всегда падала с общей ошибкой.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" && s.allowedOrigins[origin] {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodPut && r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	pubkey, err := VerifyNIP98(r, s.registerURL)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	pubkeyHash := HashPubkey(pubkey)
	ctx := r.Context()
	now := time.Now()

	switch r.Method {
	case http.MethodDelete:
		if err := s.store.Delete(ctx, pubkeyHash); err != nil {
			if err == ErrNotFound {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			log.Printf("pushbridge: delete: %v", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return

	case http.MethodPost, http.MethodPut:
		var body registerRequest
		if r.Body != nil {
			defer r.Body.Close()
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err.Error() != "EOF" {
				http.Error(w, "invalid body", http.StatusBadRequest)
				return
			}
		}
		if len(body.Groups) > MaxGroupsPerRegistration {
			http.Error(w, "too many groups", http.StatusBadRequest)
			return
		}

		var topic string
		var createdAt time.Time
		if r.Method == http.MethodPut {
			existing, err := s.store.Get(ctx, pubkeyHash)
			if err == ErrNotFound {
				http.Error(w, "not found — используйте POST для первой регистрации", http.StatusNotFound)
				return
			}
			if err != nil {
				log.Printf("pushbridge: get for update: %v", err)
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
			// ИП5: топик не меняется при обновлении фильтров — иначе клиенту
			// пришлось бы каждый раз перерегистрировать подписку в ntfy на стороне
			// приложения, а сервер отправки не в курсе, что топик сменился.
			topic = existing.Topic
			createdAt = existing.CreatedAt
		} else {
			newTopic, err := auth.GenerateToken()
			if err != nil {
				log.Printf("pushbridge: generate topic: %v", err)
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
			topic = auth.EncodeToken(newTopic)
			createdAt = now
		}

		reg := Registration{
			PubkeyHash: pubkeyHash,
			Topic:      topic,
			Groups:     body.Groups,
			CreatedAt:  createdAt,
			ExpiresAt:  now.Add(RegistrationTTL),
		}
		if err := s.store.Upsert(ctx, reg); err != nil {
			log.Printf("pushbridge: upsert: %v", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		resp := registerResponse{
			Endpoint:  fmt.Sprintf("%s/%s", s.publicTopic, topic),
			Topic:     topic,
			ExpiresAt: reg.ExpiresAt.Unix(),
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// handleInternalEvent — П0.3 (Б): плагин на пути записи relay пересылает сюда
// КАЖДОЕ опубликованное событие, строго асинхронно со своей стороны. Отвечаем
// сразу (202) и обрабатываем в фоне — так медленный ntfy/БД никогда не станет
// причиной, по которой плагин (а через него — relay) тормозит на публикации
// чужого, не связанного с push события (ИП7 «отказ моста не влияет на relay»,
// защита в глубину сверх того, что уже даёт асинхронность на стороне плагина).
func (s *Server) handleInternalEvent(w http.ResponseWriter, r *http.Request) {
	var ev RelayEvent
	if err := json.NewDecoder(r.Body).Decode(&ev); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusAccepted)

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.ProcessEvent(ctx, ev); err != nil {
			log.Printf("pushbridge: обработка события: %v", err)
		}
	}()
}

// ProcessEvent — сопоставление + склейка + публикация для одного события.
// Экспортирован отдельно от HTTP-обработчика ради тестируемости без сети.
// Ошибка одного получателя (например, ntfy временно недоступен) не должна
// прерывать обработку остальных совпавших регистраций (актуально для
// групповых сообщений — MatchResult может быть несколько) — копим и
// возвращаем одну объединённую ошибку в конце, если она была.
func (s *Server) ProcessEvent(ctx context.Context, ev RelayEvent) error {
	matches, err := s.store.Match(ctx, ev)
	if err != nil {
		return fmt.Errorf("match: %w", err)
	}

	var errs []string
	now := time.Now()
	for _, m := range matches {
		if !s.coalescer.ShouldPush(m.Topic, m.Type, now) {
			continue
		}
		if err := s.publisher.Publish(ctx, m.Topic, m.Type); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("publish errors: %s", strings.Join(errs, "; "))
	}
	return nil
}
