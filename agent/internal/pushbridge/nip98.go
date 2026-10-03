// Package pushbridge — мост между relay (путь записи strfry) и push-сервером
// ntfy. ТЗ: PROCESS-DOCS/NATIVE-APPS/TZ-PUSH-ANDROID.md, П1.2.
//
// nip98.go — проверка авторизации NIP-98 (kind 27235) для эндпоинтов
// регистрации (ИП4: регистрировать/менять/удалять push для pubkey может
// только владелец ключа). go-nostr v0.30.0 (уже используется форком Blossom,
// server/blossom/blossom-src/go.mod) не содержит пакета nip98 в этой версии —
// проверка реализована вручную поверх nostr.Event, благо она короткая: разобрать
// base64 в событие, проверить kind/u/method/время, проверить подпись.
package pushbridge

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const nip98Kind = 27235

// nip98ClockSkew — допуск по времени для created_at события авторизации.
// NIP-98 не фиксирует точное число; 60с — типичное значение у référence-реализаций
// (достаточно для сетевой задержки, мало для повторного использования старого
// токена атакующим).
const nip98ClockSkew = 60 * time.Second

// VerifyNIP98 проверяет заголовок Authorization: Nostr <base64 kind:27235 event>
// по NIP-98: kind, тег "u" (полный URL запроса), тег "method", свежесть
// created_at, корректность подписи. При успехе возвращает hex-pubkey автора.
//
// fullURL — точный URL, каким его видит клиент (схема+хост+путь), должен
// совпадать байт-в-байт с тегом "u" — так требует NIP-98; передаётся вызывающим,
// не восстанавливается из r.URL (сервер стоит за Caddy, r.URL не знает о https/
// внешнем хосте).
func VerifyNIP98(r *http.Request, fullURL string) (pubkey string, err error) {
	authHeader := r.Header.Get("Authorization")
	const prefix = "Nostr "
	if !strings.HasPrefix(authHeader, prefix) {
		return "", errors.New("nip98: заголовок Authorization отсутствует или не Nostr-схемы")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(authHeader, prefix))
	if err != nil {
		return "", fmt.Errorf("nip98: base64 невалиден: %w", err)
	}

	var evt nostr.Event
	if err := json.Unmarshal(raw, &evt); err != nil {
		return "", fmt.Errorf("nip98: событие не JSON: %w", err)
	}

	if evt.Kind != nip98Kind {
		return "", fmt.Errorf("nip98: kind=%d, ожидался %d", evt.Kind, nip98Kind)
	}

	skew := time.Since(evt.CreatedAt.Time())
	if skew < 0 {
		skew = -skew
	}
	if skew > nip98ClockSkew {
		return "", fmt.Errorf("nip98: created_at вне допуска (%s)", skew)
	}

	uTag := evt.Tags.GetFirst([]string{"u"})
	if uTag == nil || uTag.Value() != fullURL {
		return "", errors.New("nip98: тег u не совпадает с URL запроса")
	}
	methodTag := evt.Tags.GetFirst([]string{"method"})
	if methodTag == nil || !strings.EqualFold(methodTag.Value(), r.Method) {
		return "", errors.New("nip98: тег method не совпадает с HTTP-методом")
	}

	ok, err := evt.CheckSignature()
	if err != nil {
		return "", fmt.Errorf("nip98: подпись невалидна: %w", err)
	}
	if !ok {
		return "", errors.New("nip98: подпись не совпадает")
	}

	return evt.PubKey, nil
}

// HashPubkey — необратимый хеш pubkey для хранения/поиска (ИП3: pubkey в
// открытом виде в моcте не хранится без необходимости). Сопоставление входящих
// событий (тег p) с регистрациями делается тем же хешированием обеих сторон —
// равенство хешей эквивалентно равенству исходных значений, обратимость не нужна.
func HashPubkey(pubkeyHex string) string {
	h := sha256.Sum256([]byte(strings.ToLower(pubkeyHex)))
	return hex.EncodeToString(h[:])
}
