package pushbridge

import (
	"context"
	"testing"
	"time"
)

func TestMatch_GiftWrapMatchesRegisteredRecipient(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	pubkey := "aabb00"
	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey(pubkey), Topic: "topic-x", CreatedAt: now, ExpiresAt: now.Add(time.Hour)})

	res, err := s.Match(ctx, RelayEvent{Kind: KindGiftWrap, Tags: [][]string{{"p", pubkey}}})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	if len(res) != 1 || res[0].Topic != "topic-x" || res[0].Type != PushMessage {
		t.Fatalf("unexpected match result: %+v", res)
	}
}

func TestMatch_GiftWrapNoMatchForUnregistered(t *testing.T) {
	s := newTestStore(t)
	res, err := s.Match(context.Background(), RelayEvent{Kind: KindGiftWrap, Tags: [][]string{{"p", "unknown"}}})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	if len(res) != 0 {
		t.Fatalf("expected no match, got %+v", res)
	}
}

func TestMatch_GiftWrapMissingPTag(t *testing.T) {
	s := newTestStore(t)
	res, err := s.Match(context.Background(), RelayEvent{Kind: KindGiftWrap, Tags: [][]string{{"e", "something"}}})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	if len(res) != 0 {
		t.Fatalf("expected no match without p tag, got %+v", res)
	}
}

func TestMatch_CallSignalProducesCallPush(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	pubkey := "ccdd11"
	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey(pubkey), Topic: "topic-call", CreatedAt: now, ExpiresAt: now.Add(time.Hour)})

	res, err := s.Match(ctx, RelayEvent{Kind: KindCallSignal, Tags: [][]string{{"p", pubkey}}})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	if len(res) != 1 || res[0].Type != PushCall {
		t.Fatalf("expected a call push, got %+v", res)
	}
}

func TestMatch_MLSMessageMatchesGroupMembers(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey("member-a"), Topic: "topic-a", Groups: []string{"group-1"}, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey("member-b"), Topic: "topic-b", Groups: []string{"group-1"}, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey("outsider"), Topic: "topic-c", Groups: []string{"group-2"}, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})

	res, err := s.Match(ctx, RelayEvent{Kind: KindMLSMessage, Tags: [][]string{{"h", "group-1"}}})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	if len(res) != 2 {
		t.Fatalf("expected 2 group members matched, got %d: %+v", len(res), res)
	}
	for _, r := range res {
		if r.Type != PushMessage {
			t.Fatalf("group message must produce PushMessage, got %v", r.Type)
		}
	}
}

// ТЗ П1.5 «истёкшая регистрация не вызывает push».
func TestMatch_ExpiredRegistrationNoMatch(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	pubkey := "expired-owner"
	_ = s.Upsert(ctx, Registration{
		PubkeyHash: HashPubkey(pubkey),
		Topic:      "topic-expired",
		CreatedAt:  now.Add(-31 * 24 * time.Hour),
		ExpiresAt:  now.Add(-time.Hour), // истекла час назад, ещё не выметена expireLoop'ом
	})

	res, err := s.Match(ctx, RelayEvent{Kind: KindGiftWrap, Tags: [][]string{{"p", pubkey}}})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	if len(res) != 0 {
		t.Fatalf("expired registration must not match, got %+v", res)
	}

	res2, err := s.Match(ctx, RelayEvent{Kind: KindCallSignal, Tags: [][]string{{"p", pubkey}}})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	if len(res2) != 0 {
		t.Fatalf("expired registration must not match call signal either, got %+v", res2)
	}
}

func TestMatch_UnknownKindIgnored(t *testing.T) {
	s := newTestStore(t)
	res, err := s.Match(context.Background(), RelayEvent{Kind: 30060, Tags: [][]string{{"h", "some-channel"}}})
	if err != nil {
		t.Fatalf("Match: %v", err)
	}
	if len(res) != 0 {
		t.Fatalf("channel/topic kinds must never produce a push (В2 default): got %+v", res)
	}
}
