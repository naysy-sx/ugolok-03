package pushbridge

import (
	"testing"
	"time"
)

func TestCoalescer_MessageFirstAlwaysPushes(t *testing.T) {
	c := NewCoalescer(0)
	now := time.Now()
	if !c.ShouldPush("t1", PushMessage, now) {
		t.Fatal("first message event must push")
	}
}

func TestCoalescer_MessageWithinWindowSuppressed(t *testing.T) {
	c := NewCoalescer(0)
	now := time.Now()
	c.ShouldPush("t1", PushMessage, now)
	if c.ShouldPush("t1", PushMessage, now.Add(5*time.Second)) {
		t.Fatal("second message within 30s window must be suppressed")
	}
}

func TestCoalescer_MessageAfterWindowPushesAgain(t *testing.T) {
	c := NewCoalescer(0)
	now := time.Now()
	c.ShouldPush("t1", PushMessage, now)
	if !c.ShouldPush("t1", PushMessage, now.Add(31*time.Second)) {
		t.Fatal("message after window elapsed must push again")
	}
}

func TestCoalescer_MessageWindowIsPerTopic(t *testing.T) {
	c := NewCoalescer(0)
	now := time.Now()
	c.ShouldPush("topic-a", PushMessage, now)
	if !c.ShouldPush("topic-b", PushMessage, now) {
		t.Fatal("a different topic must not be affected by another topic's window")
	}
}

func TestCoalescer_CallFirstEventPushes(t *testing.T) {
	c := NewCoalescer(0)
	now := time.Now()
	if !c.ShouldPush("t1", PushCall, now) {
		t.Fatal("first call signal must push")
	}
}

func TestCoalescer_CallRapidSignalingSuppressed(t *testing.T) {
	c := NewCoalescer(0)
	now := time.Now()
	c.ShouldPush("t1", PushCall, now)
	// имитация серии ICE-кандидатов, каждый в пределах окна сессии
	for i := 1; i <= 5; i++ {
		if c.ShouldPush("t1", PushCall, now.Add(time.Duration(i)*5*time.Second)) {
			t.Fatalf("ICE-signal #%d within session gap must not push again", i)
		}
	}
}

func TestCoalescer_CallSlidingWindowExtendsWithActivity(t *testing.T) {
	c := NewCoalescer(0)
	now := time.Now()
	c.ShouldPush("t1", PushCall, now)
	// событие каждые 20с (< 30с окна) держит "сессию" живой 100с суммарно —
	// разрыв между соседними событиями никогда не достигает CallSessionGap.
	last := now
	for i := 0; i < 5; i++ {
		last = last.Add(20 * time.Second)
		if c.ShouldPush("t1", PushCall, last) {
			t.Fatalf("sliding window: signal at +%v must not repush while gaps stay under 30s", last.Sub(now))
		}
	}
}

func TestCoalescer_CallNewSessionAfterGapPushesAgain(t *testing.T) {
	c := NewCoalescer(0)
	now := time.Now()
	c.ShouldPush("t1", PushCall, now)
	afterGap := now.Add(31 * time.Second)
	if !c.ShouldPush("t1", PushCall, afterGap) {
		t.Fatal("a new call signal after the session gap must be treated as a new call and push again")
	}
}

func TestCoalescer_HourlyCapAppliesAcrossTypes(t *testing.T) {
	c := NewCoalescer(2)
	now := time.Now()
	if !c.ShouldPush("t1", PushMessage, now) {
		t.Fatal("push 1 should succeed")
	}
	// сообщение сразу за пределами окна склейки m, но в пределах часового окна
	if !c.ShouldPush("t1", PushMessage, now.Add(31*time.Second)) {
		t.Fatal("push 2 should succeed (under hourly cap)")
	}
	if c.ShouldPush("t1", PushMessage, now.Add(62*time.Second)) {
		t.Fatal("push 3 should be dropped: hourly cap of 2 reached")
	}
}

func TestCoalescer_HourlyCapResetsAfterHour(t *testing.T) {
	c := NewCoalescer(1)
	now := time.Now()
	if !c.ShouldPush("t1", PushMessage, now) {
		t.Fatal("push 1 should succeed")
	}
	if c.ShouldPush("t1", PushMessage, now.Add(45*time.Second)) {
		t.Fatal("push 2 within the same hour must be capped")
	}
	if !c.ShouldPush("t1", PushMessage, now.Add(61*time.Minute)) {
		t.Fatal("push after hour window resets must succeed again")
	}
}

func TestCoalescer_HourlyCapDisabledWhenZero(t *testing.T) {
	c := NewCoalescer(0)
	now := time.Now()
	for i := 0; i < 200; i++ {
		if !c.ShouldPush("t1", PushMessage, now.Add(time.Duration(i)*31*time.Second)) {
			t.Fatalf("iteration %d: hourly cap must be disabled when configured as 0", i)
		}
	}
}
