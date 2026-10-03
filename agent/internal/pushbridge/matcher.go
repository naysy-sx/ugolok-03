// matcher.go — сопоставление события с пути записи relay с регистрациями и
// решение о типе push. ТЗ П0.1 (матрица kind'ов), П1.2 «Слушатель».
package pushbridge

import (
	"context"
	"time"
)

// RelayEvent — минимум, который нужен мосту из события relay (не полный
// nostr.Event: мост не хранит и не логирует содержимое — ИП3). Плагин на
// пути записи (whitelist-plugin.mjs) передаёт это как JSON, см. bridgehook.go.
type RelayEvent struct {
	Kind int
	Tags [][]string // сырые теги как есть, ["p", "<hex>"], ["h", "<hex>"], ...
}

// Kind — категории из матрицы П0.1. Каналы (30060 и т.п.) сюда не входят —
// решение В2 по умолчанию "каналы не будят", матрица П0.1.
const (
	KindGiftWrap   = 1059 // личные 1:1, заявки в контакты/канал — все через одинаковый p-тег
	KindMLSMessage = 445  // групповые MLS-сообщения — тег h, без p
	KindCallSignal = 20075
)

// PushType — А3: push несёт только тип, ничего больше.
type PushType string

const (
	PushMessage PushType = "m"
	PushCall    PushType = "c"
)

func tagValue(tags [][]string, key string) (string, bool) {
	for _, t := range tags {
		if len(t) >= 2 && t[0] == key {
			return t[1], true
		}
	}
	return "", false
}

// Match — для одного события relay возвращает список (topic, тип push),
// которые должны сработать. Пустой список — категория не бьёт push (событие
// не входит в матрицу П0.1, либо получатель не зарегистрирован).
func (s *Store) Match(ctx context.Context, ev RelayEvent) ([]MatchResult, error) {
	switch ev.Kind {
	case KindGiftWrap:
		return s.matchByPTag(ctx, ev.Tags, PushMessage)

	case KindCallSignal:
		return s.matchByPTag(ctx, ev.Tags, PushCall)

	case KindMLSMessage:
		h, ok := tagValue(ev.Tags, "h")
		if !ok {
			return nil, nil
		}
		regs, err := s.AllForGroup(ctx, h, time.Now())
		if err != nil {
			return nil, err
		}
		out := make([]MatchResult, 0, len(regs))
		for _, r := range regs {
			out = append(out, MatchResult{Topic: r.Topic, PubkeyHash: r.PubkeyHash, Type: PushMessage})
		}
		return out, nil

	default:
		return nil, nil
	}
}

// matchByPTag — общий путь для kind'ов, где получатель узнаётся по тегу p
// (gift wrap, звонки). Истёкшая регистрация не даёт push — П1.2 тест-требование
// «истёкшая регистрация не вызывает push»: AllForGroup (групповой путь) уже
// фильтровал по expires_at, здесь тот же чек нужен отдельно — Store.Get
// возвращает запись независимо от срока (это её задача при других вызовах,
// например при PUT — там как раз нужна ещё не удалённая, но уже, возможно,
// просроченная запись, см. handleRegister).
func (s *Store) matchByPTag(ctx context.Context, tags [][]string, t PushType) ([]MatchResult, error) {
	p, ok := tagValue(tags, "p")
	if !ok {
		return nil, nil
	}
	reg, err := s.Get(ctx, HashPubkey(p))
	if err == ErrNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if reg.ExpiresAt.Before(time.Now()) {
		return nil, nil
	}
	return []MatchResult{{Topic: reg.Topic, PubkeyHash: reg.PubkeyHash, Type: t}}, nil
}

type MatchResult struct {
	Topic      string
	PubkeyHash string
	Type       PushType
}
