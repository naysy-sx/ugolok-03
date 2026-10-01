package pushbridge

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "push.db")
	s, err := OpenStore(path)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestStore_UpsertAndGet(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now().Truncate(time.Second)

	reg := Registration{
		PubkeyHash: HashPubkey("aabbcc"),
		Topic:      "topic-1",
		Groups:     []string{"group-a", "group-b"},
		CreatedAt:  now,
		ExpiresAt:  now.Add(RegistrationTTL),
	}
	if err := s.Upsert(ctx, reg); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	got, err := s.Get(ctx, reg.PubkeyHash)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Topic != reg.Topic || len(got.Groups) != 2 || got.Groups[0] != "group-a" {
		t.Fatalf("unexpected registration: %+v", got)
	}
}

func TestStore_GetMissing(t *testing.T) {
	s := newTestStore(t)
	_, err := s.Get(context.Background(), "no-such-hash")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestStore_UpsertReplacesFilters(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now().Truncate(time.Second)
	hash := HashPubkey("dead")

	_ = s.Upsert(ctx, Registration{PubkeyHash: hash, Topic: "t1", Groups: []string{"g1"}, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	_ = s.Upsert(ctx, Registration{PubkeyHash: hash, Topic: "t1", Groups: []string{"g1", "g2"}, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})

	got, err := s.Get(ctx, hash)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got.Groups) != 2 {
		t.Fatalf("expected updated groups (2), got %v", got.Groups)
	}
}

func TestStore_Delete(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	hash := HashPubkey("beef")
	_ = s.Upsert(ctx, Registration{PubkeyHash: hash, Topic: "t2", CreatedAt: now, ExpiresAt: now.Add(time.Hour)})

	if err := s.Delete(ctx, hash); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get(ctx, hash); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}
}

func TestStore_DeleteMissing(t *testing.T) {
	s := newTestStore(t)
	if err := s.Delete(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestStore_DeleteExpired(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now()

	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey("expired"), Topic: "te", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)})
	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey("fresh"), Topic: "tf", CreatedAt: now, ExpiresAt: now.Add(time.Hour)})

	n, err := s.DeleteExpired(ctx, now)
	if err != nil {
		t.Fatalf("DeleteExpired: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 deleted, got %d", n)
	}
	if _, err := s.Get(ctx, HashPubkey("fresh")); err != nil {
		t.Fatalf("fresh registration must survive: %v", err)
	}
	if _, err := s.Get(ctx, HashPubkey("expired")); !errors.Is(err, ErrNotFound) {
		t.Fatal("expired registration must be gone")
	}
}

func TestStore_AllForGroup(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Now()

	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey("a"), Topic: "ta", Groups: []string{"g1", "g2"}, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey("b"), Topic: "tb", Groups: []string{"g2"}, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey("c"), Topic: "tc", Groups: []string{"g3"}, CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	// истёкшая — не должна попасть в выборку, даже если группа совпадает
	_ = s.Upsert(ctx, Registration{PubkeyHash: HashPubkey("d"), Topic: "td", Groups: []string{"g2"}, CreatedAt: now.Add(-time.Hour), ExpiresAt: now.Add(-time.Minute)})

	matches, err := s.AllForGroup(ctx, "g2", now)
	if err != nil {
		t.Fatalf("AllForGroup: %v", err)
	}
	if len(matches) != 2 {
		t.Fatalf("expected 2 matches for g2, got %d: %+v", len(matches), matches)
	}
}
