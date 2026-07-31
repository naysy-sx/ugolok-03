# ТЗ: логика голосового звонка (Уголок) — call state machine + ICE restart

> Пункт 5 из архитектуры голосовой связи. Проектирование: Rosen (формальный FSM) → Erickson (робастность, edge cases) → Frisby (модульный контракт).
> Формат рассчитан на исполнение через Claude Code + субагенты (qwen2.5-coder:7b). Незакрытых пар в таблице переходов нет — воркеру нечего додумывать.

---

## 0. Границы задачи

**Реализуем:** чистое ядро логики звонка (FSM) + runtime, исполняющий команды.
**НЕ реализуем здесь** (отдельные модули, только контракт): Nostr-транспорт сигналинга, обёртку над `RTCPeerConnection`, UI.

**Стек:** JS (ES-модули). Ядро (`reduce`) — без I/O, без `async`, изоморфно (браузер + Node), чтобы тесты гонялись в Node без DOM.

**Скоуп v1:** только 1:1 (два участника). Групповой mesh — вне скоупа, но модель на нём не ломается.

**Архитектурный принцип:** functional core / imperative shell. Вся логика решений — в чистой функции `reduce(state, event) → { state, commands }`. Всё, что имеет побочный эффект (отправить событие в Nostr, создать offer, завести таймер), выражено *командой*, которую исполняет runtime. FSM ничего не знает про WebRTC и Nostr — только про типы событий и команд.

---

## 1. Формальная модель (Rosen)

FSM = ⟨Q, Σ_in, Σ_out, δ, q₀⟩.

### 1.1 Состояния Q

| Состояние | Смысл | Тип |
|---|---|---|
| `IDLE` | нет звонка | стартовое / покоя |
| `OUTGOING_RINGING` | я позвонил, жду ответа | ожидание |
| `INCOMING_RINGING` | мне звонят, жду решения пользователя | ожидание |
| `CONNECTING` | оффер/ансвер обменяны, идёт ICE-согласование | ожидание |
| `CONNECTED` | медиа течёт | рабочее |
| `RECONNECTING` | связь была, ICE упал, восстанавливаемся | ожидание |
| `ENDED` | звонок завершён (с `reason`) | терминальное |

`ENDED` после очистки ресурсов переходит в `IDLE` (новый звонок начинается из `IDLE`). `reason` — payload для UI, не влияет на переходы.

### 1.2 Данные сессии (state payload)

```
state = {
  name,          // одно из Q
  role,          // 'caller' | 'callee' | null
  sessionId,     // uuid, генерит caller; идентификатор одного звонка
  peerPubkey,    // pubkey собеседника
  polite,        // bool = (myPubkey < peerPubkey)  — тайбрейкер glare
  restartCount,  // счётчик попыток ICE restart, сброс при возврате в CONNECTED
  reason,        // причина завершения (только в ENDED)
}
```

### 1.3 Входной алфавит Σ_in (события)

Четыре источника. Каждое событие несёт `sessionId` (кроме `USER_PLACE_CALL` и `REMOTE_OFFER`, которые сессию создают/приносят).

**A. Пользователь (UI):** `USER_PLACE_CALL(peerPubkey)`, `USER_ACCEPT`, `USER_REJECT`, `USER_HANGUP`

**B. Сигналинг из Nostr:** `REMOTE_OFFER(sdp, sessionId, fromPubkey)`, `REMOTE_ANSWER(sdp)`, `REMOTE_ICE(candidate)`, `REMOTE_HANGUP`

**C. Медиа (колбэки RTCPeerConnection):** `LOCAL_OFFER_READY(sdp)`, `LOCAL_ANSWER_READY(sdp)`, `LOCAL_ICE(candidate)`, `ICE_CONNECTED`, `ICE_DISCONNECTED`, `ICE_FAILED`

**D. Таймеры:** `RING_TIMEOUT`, `CONNECT_TIMEOUT`, `GRACE_EXPIRED`, `BACKOFF_EXPIRED`

### 1.4 Выходной алфавит Σ_out (команды)

**Сигналинг наружу:** `SEND_OFFER(sdp)`, `SEND_ANSWER(sdp)`, `SEND_ICE(candidate)`, `SEND_HANGUP`
**Медиа-операции:** `ACQUIRE_MIC`, `CREATE_OFFER`, `CREATE_ANSWER`, `SET_REMOTE(sdp)`, `ADD_ICE(candidate)`, `DO_ICE_RESTART`, `CLOSE_PC`
**Таймеры:** `START_TIMER(name, ms)`, `CANCEL_TIMER(name)`
**UI:** `EMIT(stateName, reason?)`

> `ADD_ICE` безопасен всегда: буферизацию «кандидат пришёл до setRemoteDescription» инкапсулирует `MediaController` (см. §3). FSM про это не думает.

### 1.5 Инварианты (обязательны, покрыть тестами)

- **I1.** Активна не более одной сессии. Событие с `sessionId ≠ state.sessionId` игнорируется (защита от дублей и устаревших событий Nostr).
- **I2.** `RECONNECTING` достижимо только из `CONNECTED`.
- **I3.** У каждого нетерминального состояния кроме `IDLE` есть таймаут-переход → нет вечного залипания.
- **I4.** `restartCount ≤ MAX_RESTARTS` → цикл рестартов завершается.
- **I5. Тотальность δ.** Для любой пары (состояние, событие), не описанной в §2, действие = *игнорировать* (залогировать, состояние без изменений). Явное правило по умолчанию.

---

## 2. Таблица переходов δ (Rosen + Erickson)

Формат строки: **Событие → Новое состояние `[команды]`**. Всё, что не в таблице для данного состояния, → по I5 игнорируется.

### `IDLE`
- `USER_PLACE_CALL(peer)` → `OUTGOING_RINGING` `[ACQUIRE_MIC, CREATE_OFFER, START_TIMER(ring, 30000), EMIT]`
  *(генерим sessionId, role=caller, polite=(my<peer))*
- `REMOTE_OFFER(sdp, sid, from)` → `INCOMING_RINGING` `[SET_REMOTE(sdp), START_TIMER(ring, 30000), EMIT]`
  *(role=callee, sessionId=sid, peer=from, polite=(my<from))*

### `OUTGOING_RINGING` (caller)
- `LOCAL_OFFER_READY(sdp)` → *(stay)* `[SEND_OFFER(sdp)]`
- `LOCAL_ICE(c)` → *(stay)* `[SEND_ICE(c)]`  *(trickle ICE)*
- `REMOTE_ANSWER(sdp)` → `CONNECTING` `[SET_REMOTE(sdp), CANCEL_TIMER(ring), START_TIMER(connect, 15000), EMIT]`
- `REMOTE_ICE(c)` → *(stay)* `[ADD_ICE(c)]`
- `RING_TIMEOUT` → `ENDED(no_answer)` `[SEND_HANGUP, CLOSE_PC, EMIT]`
- `USER_HANGUP` → `ENDED(cancelled)` `[SEND_HANGUP, CLOSE_PC, CANCEL_TIMER(ring), EMIT]`
- `REMOTE_HANGUP` → `ENDED(rejected)` `[CLOSE_PC, CANCEL_TIMER(ring), EMIT]`
- **`REMOTE_OFFER(sdp)` от того же peer → GLARE** (см. §2.1)

### `INCOMING_RINGING` (callee)
- `REMOTE_ICE(c)` → *(stay)* `[ADD_ICE(c)]`  *(remote desc уже установлен на входе)*
- `USER_ACCEPT` → `CONNECTING` `[ACQUIRE_MIC, CREATE_ANSWER, CANCEL_TIMER(ring), START_TIMER(connect, 15000), EMIT]`
- `USER_REJECT` → `ENDED(rejected)` `[SEND_HANGUP, CLOSE_PC, CANCEL_TIMER(ring), EMIT]`
- `RING_TIMEOUT` → `ENDED(missed)` `[SEND_HANGUP, CLOSE_PC, EMIT]`
- `REMOTE_HANGUP` → `ENDED(cancelled_by_caller)` `[CLOSE_PC, CANCEL_TIMER(ring), EMIT]`

### `CONNECTING` (оба)
- `LOCAL_ANSWER_READY(sdp)` → *(stay)* `[SEND_ANSWER(sdp)]`  *(только callee)*
- `LOCAL_ICE(c)` → *(stay)* `[SEND_ICE(c)]`
- `REMOTE_ICE(c)` → *(stay)* `[ADD_ICE(c)]`
- `ICE_CONNECTED` → `CONNECTED` `[CANCEL_TIMER(connect), EMIT]`  *(restartCount=0)*
- `ICE_FAILED` → `ENDED(connect_failed)` `[SEND_HANGUP, CLOSE_PC, EMIT]`
  *(рестарт бессмысленен до первого успешного коннекта — сдаёмся)*
- `CONNECT_TIMEOUT` → `ENDED(connect_failed)` `[SEND_HANGUP, CLOSE_PC, EMIT]`
- `USER_HANGUP` → `ENDED(hangup)` `[SEND_HANGUP, CLOSE_PC, CANCEL_TIMER(connect), EMIT]`
- `REMOTE_HANGUP` → `ENDED(remote_hangup)` `[CLOSE_PC, CANCEL_TIMER(connect), EMIT]`

### `CONNECTED` (оба)
- `LOCAL_ICE(c)` → *(stay)* `[SEND_ICE(c)]`
- `REMOTE_ICE(c)` → *(stay)* `[ADD_ICE(c)]`
- `ICE_DISCONNECTED` → `RECONNECTING` `[START_TIMER(grace, 4000), EMIT]`
- `REMOTE_OFFER(sdp)` → *(stay)* `[SET_REMOTE(sdp), CREATE_ANSWER]`  *(peer инициировал ICE restart — отвечаем, см. §2.2)*
- `USER_HANGUP` → `ENDED(hangup)` `[SEND_HANGUP, CLOSE_PC, EMIT]`
- `REMOTE_HANGUP` → `ENDED(remote_hangup)` `[CLOSE_PC, EMIT]`

### `RECONNECTING` (ICE restart — ядро отказоустойчивости, §2.2)
- `ICE_CONNECTED` → `CONNECTED` `[CANCEL_TIMER(grace), CANCEL_TIMER(backoff), EMIT]`  *(restartCount=0 — самолечение или успешный рестарт)*
- `GRACE_EXPIRED` / `BACKOFF_EXPIRED` / `ICE_FAILED` → **логика рестарта:**
    - если `restartCount < MAX_RESTARTS` **и** `!polite`: → *(stay)* `[DO_ICE_RESTART, START_TIMER(backoff, backoff(restartCount))]`, `restartCount++`
    - если `restartCount < MAX_RESTARTS` **и** `polite`: → *(stay)* `[START_TIMER(backoff, backoff(restartCount))]` *(ждём restart-оффер от impolite-пира)*, `restartCount++`
    - иначе → `ENDED(connection_lost)` `[CLOSE_PC, EMIT]`
- `LOCAL_OFFER_READY(sdp)` → *(stay)* `[SEND_OFFER(sdp)]`  *(результат нашего DO_ICE_RESTART)*
- `REMOTE_OFFER(sdp)` → *(stay)* `[SET_REMOTE(sdp), CREATE_ANSWER]`  *(polite принял restart-оффер)*
- `REMOTE_ANSWER(sdp)` → *(stay)* `[SET_REMOTE(sdp)]`  *(impolite получил ответ на свой restart)*
- `LOCAL_ANSWER_READY(sdp)` → *(stay)* `[SEND_ANSWER(sdp)]`
- `LOCAL_ICE(c)` → *(stay)* `[SEND_ICE(c)]`
- `REMOTE_ICE(c)` → *(stay)* `[ADD_ICE(c)]`
- `USER_HANGUP` → `ENDED(hangup)` `[SEND_HANGUP, CLOSE_PC, EMIT]`
- `REMOTE_HANGUP` → `ENDED(remote_hangup)` `[CLOSE_PC, EMIT]`

### 2.1 Glare — одновременный звонок (Erickson, критично)

Оба пира вызвали друг друга; в `OUTGOING_RINGING` приходит `REMOTE_OFFER` от того же peer. Разрешение через `polite = (myPubkey < peerPubkey)` — детерминированно, без вечной пересборки:

- **polite-пир** (`myPubkey < peerPubkey`): отменяет свой исходящий оффер и принимает входящий (звонить он и так хотел). Переход → `CONNECTING` как callee. Команды: `[SET_REMOTE(offer_sdp) с предварительным rollback локального описания, CREATE_ANSWER, CANCEL_TIMER(ring), START_TIMER(connect, 15000), EMIT]`, role=callee.
- **impolite-пир** (`myPubkey > peerPubkey`): игнорирует входящий `REMOTE_OFFER`, остаётся caller — его оффер будет отвечен polite-пиром.

> ⚠️ **Точка риска для воркера.** Rollback локального описания (`setLocalDescription({type:'rollback'})`) завязан на `signalingState` реального `RTCPeerConnection`. Реализацию `SET_REMOTE`-с-rollback пишет **Claude напрямую**, не qwen-воркер (triage 13a). В FSM это остаётся одной командой `SET_REMOTE`; вся возня с rollback — внутри `MediaController`.

### 2.2 ICE restart — как это работает по шагам

`disconnected` часто самолечится сам → сначала `grace` 4 с. Не помогло (`GRACE_EXPIRED`/`ICE_FAILED`) → рестарт инициирует **только impolite-пир**: `DO_ICE_RESTART` = `createOffer({iceRestart:true})` → новый `LOCAL_OFFER_READY` → `SEND_OFFER` через Nostr. Polite-пир получает `REMOTE_OFFER` (уже будучи в `RECONNECTING`) → `CREATE_ANSWER` → `SEND_ANSWER`. Дальше обычный ICE, `ICE_CONNECTED` → назад в `CONNECTED`. Так двусторонний glare при восстановлении исключён тем же тайбрейкером.

---

## 3. Модульный контракт (Frisby) — заморозить в CONTRACTS.md

```
call-fsm.js         — pure. export reduce(state, event) → { state, commands }.
                      Ноль I/O, ноль async. Только это пишет воркер.
call-runtime.js     — imperative shell. Подписан на media + signaling,
                      кормит события в reduce(), исполняет commands.
media-controller.js — обёртка RTCPeerConnection. Исполняет медиа-команды,
                      эмитит медиа-события. Внутри: буфер ICE до setRemoteDescription,
                      rollback при glare. Пишет Claude.
signaling-adapter.js— Nostr in/out. SEND_* → publish (NIP-44, kind по NIP-100/новому спеку);
                      входящие события → REMOTE_*. Пишет Claude (частично есть).
```

**Заморозить как контракт:** union-тип `Event`, union-тип `Command`, форму `State` (§1.2). Ядро и оболочка общаются только через них.

**Ключевое разделение ответственности:**
- `reduce` — *решает* (детерминированно, тестируемо, без внешнего мира).
- `runtime` — *исполняет* (побочные эффекты, порядок, доставка).
- `MediaController` прячет всю грязь WebRTC-API (буферизация ICE, rollback), поэтому FSM остаётся чистым.

**Константы (Erickson):**
```
RING_TIMEOUT     = 30000  // мс: сколько звоним
CONNECT_TIMEOUT  = 15000  // мс: на ICE-согласование
DISCONNECT_GRACE = 4000   // мс: ждём самолечения до рестарта
MAX_RESTARTS     = 4
backoff(n)       = min(1000 * 2**(n-1), 8000)  // 1s,2s,4s,8s,cap 8s
```

---

## 4. Тест-спека (test-first, для gate воркера)

Ядро чистое → тесты табличные: строка = `(state_in, event) ⇒ (state_out, commands)`. Обязательные кейсы:

1. **Happy caller:** IDLE→OUTGOING→(offer→answer)→CONNECTING→CONNECTED.
2. **Happy callee:** IDLE→(offer)→INCOMING→(accept)→CONNECTING→(answer, ice_connected)→CONNECTED.
3. **Ring timeout** у caller и callee → ENDED(no_answer / missed).
4. **Reject:** callee USER_REJECT → ENDED(rejected); caller видит REMOTE_HANGUP.
5. **Glare, polite-ветка:** OUTGOING + REMOTE_OFFER → CONNECTING как callee.
6. **Glare, impolite-ветка:** OUTGOING + REMOTE_OFFER → игнор, остаётся caller.
7. **Самолечение:** CONNECTED→ICE_DISCONNECTED→RECONNECTING→ICE_CONNECTED→CONNECTED (restartCount=0).
8. **Рестарт с восстановлением:** …→GRACE_EXPIRED→(impolite: DO_ICE_RESTART)→ICE_CONNECTED→CONNECTED.
9. **Исчерпание рестартов:** MAX_RESTARTS попыток → ENDED(connection_lost). *(проверка I4 — завершаемость)*
10. **Устаревшая сессия:** событие с чужим sessionId → игнор, состояние не меняется. *(I1)*
11. **Тотальность:** случайное событие в случайном состоянии, не описанное в δ → без изменений. *(I5)*

Gate воркера: все 11 групп зелёные + `reduce` без I/O/async (проверить статикой) → git-чекпоинт.

---

## 5. Декомпозиция для Claude Code + субагентов

| # | Задача | Исполнитель | Почему |
|---|---|---|---|
| 1 | `call-fsm.js` (`reduce` по §2) + табличные тесты §4 | **воркер** (qwen) | чисто, полностью специфицировано, гадать нечего |
| 2 | `media-controller.js`: обёртка RTCPeerConnection, буфер ICE, glare-rollback | **Claude** | внешний async-API + rollback (triage 13a) |
| 3 | `signaling-adapter.js`: маппинг команд ↔ Nostr-события | **Claude** | завязка на NIP-44/шифрование, есть частично |
| 4 | `call-runtime.js`: проводка событий и команд | **Claude** (оркестрация) | интеграция, порядок эффектов |

Порядок: 1 первым (ядро + тесты как контракт поведения) → 2,3 параллельно против замороженного `Command`/`Event` → 4 сшивает. Каждый шаг — свой git-чекпоинт, пять гейтов DoD применяются к каждой задаче отдельно.

---

## Открытые развилки (решить до старта — не молча)

1. **Инициатор рестарта.** Взято: impolite инициирует, polite ждёт. *Альтернатива:* оба могут инициировать, а возникший glare гасится правилом §2.1 — устойчивее к «немому» пиру, но сложнее тесты. Помечаю как обоснованную гипотезу; для v1 рекомендую простой вариант.
2. **Kind Nostr-событий сигналинга.** NIP-100 (как у 0xchat) vs новый спек с NIP-59 gift-wrap. Влияет только на `signaling-adapter`, ядра не касается — можно решить позже.
3. **ICE servers.** STUN-only на старте (медиа не через сервер); coturn-fallback — отдельным конфигом, вне этого ТЗ.

---

## Записка от самого Claude Code 

Три вещи, на которые обращу внимание отдельно, потому что они несут основную нагрузку:

Glare — единственное место, где я честно поставил флаг «риск». Rollback локального описания при одновременном звонке завязан на реальный signalingState живого RTCPeerConnection — это не вписывается в чистое ядро и не годится для воркера. В ТЗ он спрятан внутри MediaController как одна команда SET_REMOTE, а его реализацию я явно отдал Claude, не qwen. Если пропустить этот нюанс — получишь редкий, невоспроизводимый баг «иногда звонок сам себя убивает», который потом мучительно ловить.

Тайбрейкер polite = (myPubkey < peerPubkey) работает дважды — и в glare, и в выборе инициатора рестарта. Один и тот же порядок на pubkey закрывает оба класса гонок. Это не случайность: и там, и там проблема одна — два симметричных пира принимают конфликтующие решения одновременно, а тотальный порядок разрывает симметрию детерминированно.

Чистота reduce — не эстетика, а прямая экономия на твоём пайплайне. Ядро без I/O и без async → тесты табличные и детерминированные → воркер либо проходит все 11 групп, либо нет, без «плавающих» падений. Это ровно тот gate, после которого не страшно ставить git-чекпоинт.

Один момент, где я мог ошибиться и стоит проверить при реализации: я заложил, что addIceCandidate безопасен всегда, спрятав буферизацию в MediaController. Это стандартная практика, но конкретное поведение зависит от того, как ты обёртку напишешь — если решишь буферизацию не прятать, а тащить в FSM, то в таблице появятся состояния «до/после setRemoteDescription» и она заметно распухнет. Я выбрал прятать — но это развилка, а не факт, и я предпочёл назвать её явно, чем протащить молча.

Перед тем как отдавать в Claude Code — три открытые развилки в конце файла (инициатор рестарта, kind Nostr-события, ICE servers) стоит закрыть, иначе воркер упрётся в них по правилу 9a и остановится. Первую могу разложить подробнее, если хочешь взвесить простой вариант против устойчивого.