// coalesce.go — склейка и лимиты push (ТЗ П1.2 «Склейка и лимиты»).
//
// Анти-дубликат для звонков (kind 20075) — открытый вопрос, оставленный в
// PUSH-E0-REPORT.md («П0.1», находка про звонки): один и тот же kind 20075
// используют и приглашение (offer), и ICE-кандидаты уже идущего разговора,
// и служебные сигналы во время звонка (RECONNECTING и т.п. — см.
// signaling-adapter.js) — все с одинаковым тегом p, мост не видит payload.type
// (NIP-44, зашифровано). Различить их без расшифровки нельзя в принципе.
//
// Решение: скользящее окно "сессии звонка" на CallSessionGap (= RING_TIMEOUT
// из src/domain/calls/call-fsm.js, 30с — таймаут ожидания ответа). Каждое
// kind:20075-событие сдвигает конец окна; push `c` шлётся только на событие,
// которое НАЧИНАЕТ новую сессию (разрыв с предыдущим событием ≥ окна). Пока
// события идут чаще, чем раз в 30с (звонок звонит, идёт ICE-обмен, держит
// соединение) — новых push не будет. Известное ограничение (честно, не
// скрывается): если у уже принятого разговора случится пауза в сигналинге
// дольше 30с, а затем придёт ещё один kind:20075 (например переподключение) —
// это по ошибке даст один лишний push "входящий звонок". Плата за то, что
// контент недоступен мосту в принципе (А3, приватность) — компромисс
// зафиксирован здесь, не переоткрывать без явного решения владельца.
package pushbridge

import (
	"sync"
	"time"
)

// MessageCoalesceWindow — П1.2: «m — не чаще 1 раза в 30 с на топик».
const MessageCoalesceWindow = 30 * time.Second

// CallSessionGap — см. комментарий пакета выше. Значение синхронизировано
// вручную с RING_TIMEOUT в src/domain/calls/call-fsm.js — нет автоматической
// связи между JS и Go кодом в разных модулях сборки; если RING_TIMEOUT
// поменяется, эту константу нужно поменять вручную (заметка для ревью П1
// в будущем, если таймер звонка когда-нибудь тронут).
const CallSessionGap = 30 * time.Second

type topicState struct {
	lastMessagePushAt time.Time
	lastCallEventAt   time.Time
	hourWindowStart   time.Time
	hourCount         int
}

// Coalescer — состояние в памяти процесса (ИП3: мост не хранит события —
// только служебные метки времени, не переживает перезапуск, что нормально:
// после рестарта первое событие каждого типа просто снова пройдёт как "новое").
type Coalescer struct {
	mu        sync.Mutex
	hourlyCap int
	topics    map[string]*topicState
}

func NewCoalescer(hourlyCap int) *Coalescer {
	return &Coalescer{hourlyCap: hourlyCap, topics: make(map[string]*topicState)}
}

// ShouldPush решает, слать ли push для данного топика и типа в момент now.
// Обновляет внутреннее состояние независимо от решения — так session-таймер
// звонка и счётчик часового лимита остаются корректными для следующего вызова.
func (c *Coalescer) ShouldPush(topic string, t PushType, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	st, ok := c.topics[topic]
	if !ok {
		st = &topicState{}
		c.topics[topic] = st
	}

	var wantsPush bool
	switch t {
	case PushMessage:
		wantsPush = st.lastMessagePushAt.IsZero() || now.Sub(st.lastMessagePushAt) >= MessageCoalesceWindow
		if wantsPush {
			st.lastMessagePushAt = now
		}
	case PushCall:
		wantsPush = st.lastCallEventAt.IsZero() || now.Sub(st.lastCallEventAt) >= CallSessionGap
		st.lastCallEventAt = now // сдвигаем окно сессии независимо от решения о push
	default:
		return false
	}

	if !wantsPush {
		return false
	}
	return c.allowHourly(st, now)
}

// allowHourly — общий потолок на топик в час (защита батареи получателя).
// Вызывается уже под c.mu — не берёт лок сам.
func (c *Coalescer) allowHourly(st *topicState, now time.Time) bool {
	if c.hourlyCap <= 0 {
		return true // 0/отрицательное — лимит выключен явно конфигом
	}
	if st.hourWindowStart.IsZero() || now.Sub(st.hourWindowStart) >= time.Hour {
		st.hourWindowStart = now
		st.hourCount = 0
	}
	if st.hourCount >= c.hourlyCap {
		return false
	}
	st.hourCount++
	return true
}
