# Формат трассировки звонков (`?diag=1`)

Реализация: `PROCESS-DOCS/VPS/AUDIO/TZ-diag-trace.md`. Модуль:
`src/core/diag/call-trace.js`. Назначение — превратить гипотезы аудита
обрывов связи (`artifacts/call-audit/09-FINAL-AUDIT.md`) в проверяемые факты
по машинно-сшиваемой записи с обеих сторон реального звонка. Логику звонков
эта система не меняет — см. `TZ-diag-trace.md` §0 и явный список того, что
**не** было исправлено, в отчёте по этой задаче.

## Как включить и снять

См. `docs/RUNBOOK.md` §6.11.

## Формат файла

Выгрузка (кнопка «Скачать файл» / `window.__ugolokTrace.save()`) — один JSON:

```json
{
  "sid": "a1b2c3d4e5f6",
  "exportedAt": "2026-09-08T21:14:03.512Z",
  "events": [ /* массив записей, см. ниже */ ]
}
```

## Формат одной записи

Плоский объект. Общие поля есть у КАЖДОЙ записи:

| Поле | Тип | Смысл |
|---|---|---|
| `t` | ISO-строка (UTC) | `new Date().toISOString()` в момент записи — по нему сшиваются записи с разных сторон/устройств. |
| `mono` | число (мс) | `performance.now()` — монотонное время ЭТОЙ вкладки, для порядка событий внутри одной сессии (не сравнимо между вкладками/устройствами). |
| `sid` | строка | Идентификатор загрузки вкладки — один на весь визит, переживает `page-reload` (см. ниже). |
| `ev` | строка | Вид события — таблица ниже. |
| `pc` | строка (когда есть) | Идентификатор конкретного `RTCPeerConnection` — привязывает событие к конкретному звонку/голосовому ребру комнаты. |
| остальное | зависит от `ev` | Полезная нагрузка события. |

## Санитизация (применяется КО ВСЕМ записям централизованно в `record()`)

- Поля `address`/`ip` — маскируются: IPv4 до `/24` (`203.0.113.7` →
  `203.0.113.0/24`), IPv6 — до первых 4 групп + `::/64` (проектное решение,
  ТЗ явно оговаривает только IPv4).
- Поля `pubkey`/`peer`/`peerPubkey`/`fromPubkey`/`toPubkey`/`selfPubkey`/
  `senderPubkey`/`myPubkey` — усекаются до первых 8 символов + `…`.
- Поля `privKey`/`privateKey`/`secretKey`/`mnemonic`/`secret`/
  `staticAuthSecret`/`credential`/`password`/`content`/`plaintext`/`sdp` —
  **удаляются целиком**, даже если что-то по ошибке их передаст.
- Из SDP в запись попадают только `iceUfrag` (значение строки `a=ice-ufrag`)
  и `candidateCount` (число строк `a=candidate`) — извлекаются ДО передачи в
  трассировщик (`call-runtime.js`), полный текст SDP никогда не хранится.

## Виды событий (`ev`)

### Соединение (`media-controller.js`, на каждый `RTCPeerConnection`)

- **`created`** — `{ pc, uris, hasCredentials, ttlRemainingSec }`. `uris` —
  список ICE-серверов (`turn:`/`stun:`), `hasCredentials` — есть ли
  username/credential хоть у одного, `ttlRemainingSec` — сколько секунд
  оставалось до истечения кэшированных TURN-кредов на момент создания
  (`null`, если кредов не было).
- **`statechange`** — `{ pc, iceConnectionState, connectionState, signalingState, iceGatheringState }` — снимок ВСЕХ четырёх состояний при смене любого из них.
- **`icecandidate`** — `{ pc, candidateType, protocol, address, port, gatheringDone }` либо `{ pc, gatheringDone: true }` на конец сбора.
- **`track`** — `{ pc, kind, added: true }` при получении удалённого трека; `{ pc, kind, muteEvent: "mute"|"unmute"|"ended" }` на соответствующих событиях трека.
- **`negotiationneeded`** — `{ pc }`.
- **`stats`** — раз в секунду, пока соединение открыто: `{ pc, dtlsState, iceState, pairPath, currentRoundTripTime, bytesSent, bytesReceived, requestsSent, responsesReceived, consentRequestsSent, inboundPacketsReceived, inboundPacketsLost, inboundJitter, outboundPacketsSent }`. `pairPath` — вид `"srflx/udp -> relay/udp"`. **Ключевое поле для различения «первой умерла сеть» от «звонок завершило приложение»**: если `bytesReceived`/`responsesReceived` перестали расти РАНЬШЕ смены `iceConnectionState` — умерла сеть; если состояние сменилось, а счётчики ещё растут — решение принял код.

### Машина состояний звонка (`call-runtime.js`)

- **`fsm-transition`** — `{ sessionId, peerPubkey, from, to, event, reason, restartCount }` — каждый переход `call-fsm.js`'s `reduce()`, включая `restartCount` на этот момент (аудит показал: собственный бюджет реконнекта ≈19-20с, короче наблюдаемых 2-10 минут — это поле показывает, не флаппает ли `ICE_CONNECTED`/`ICE_DISCONNECTED` многократно за один пользовательский «звонок»).
- **`timer`** — `{ name, ms, phase: "armed"|"fired", sessionId }` — `name` один из `ring`/`connect`/`grace`/`backoff`.
- **`command`** — самое важное событие набора, см. ниже отдельно.

### `command` — исполнение команды FSM

- `phase: "start"` — `{ name, sessionId, relayState? }`. `relayState` — только у сигнальных команд (`SEND_*`), снимок `relay-pool.js`'s `getState()` В МОМЕНТ попытки отправки.
- `phase: "ok"` — медиа-команды: `{ name, sessionId }`. Сигнальные команды: `{ name, sessionId, relayOk, relayReason, eventId, iceUfrag?, candidateCount? }`. **`relayOk`/`eventId` — это реальное подтверждение `OK` от релея по идентификатору события, а не факт, что `publish()` не бросил исключение.** На полуживом сокете `send()` может не бросить, а событие не дойти — тогда `relayOk` будет `undefined`, потому что промис `publish()` может либо так и не разрешиться (это будет видно как `command`/`start` без последующего `command`/`ok` или `error` для этого вызова), либо разрешиться без `ok`, если релей вообще не прислал `OK`.
- `phase: "error"` — `{ name, sessionId, errorMessage }`. Команда **потеряна навсегда** — retry не добавлен (`TZ-diag-trace.md` §0.1, `09-FINAL-AUDIT.md` §2).

### Сигнализация/транспорт (`relay-pool.js`, оба транспорта — общий сокет 1:1 и отдельный сокет комнаты)

- **`connect-attempt`** — `{ url }`.
- **`open`** — `{ url }`.
- **`resubscribe`** — `{ url, subIds }` — какие REQ-подписки реплеятся после реконнекта.
- **`close`** — `{ url, code, reason }` — код и причина закрытия WebSocket (`1006` — аварийный обрыв без штатного close-фрейма, характерная сигнатура «сеть пропала», см. живые логи прод-VPS в `09-FINAL-AUDIT.md` §3).
- **`error`** — `{ url, message }`.
- **`reconnect-scheduled`** — `{ url, attempt, delayMs }`.

### Комната («Быстрая связь», `mesh-supervisor.js`)

- **`edge-state`** — `{ peer, role, state, generation }` — переход конкретного голосового ребра (те же состояния `call-fsm.js`, что и у 1:1).
- **`roster-diff`** — `{ toOpen, toClose, reopened, desired, actual }` — только когда сверка реально открыла, закрыла или пересоздала ребро.
- **`edge-health`** — раз в 2 с на ребро: `{ peer, state, packetsReceived, bytesReceived, jitter, localType, remoteType }`. `localType`/`remoteType` — `host` | `srflx` | `relay`. По росту `packetsReceived` в `CONNECTED` отличают «ребро встало» от «ICE сошёлся, RTP нет».
- **`play-attempt`** / **`play-rejected`** — из пула `<audio>` комнаты: `{ peer, ok: true }` либо `{ peer, name }` (`err.name`).
- **`turn-status`** — из `resolveCallIceServers`: `{ status: "ok"|"unavailable"|"not-configured", urlCount, tookMs }`.
- **`publish-result`** — на каждое событие kind 20075: `{ commandType, sessionId, ok, reason, tookMs }`.

### Окружение и жизненный цикл (`main.jsx`, `call-overlay.jsx`, `service-worker.js`)

- **`env`** — один раз при загрузке вкладки: `{ buildHash, userAgent, isMobile, timezone, utcOffsetMin }`.
- **`visibilitychange`** — `{ state }` (`"visible"|"hidden"`).
- **`online`** / **`offline`** — без полезной нагрузки.
- **`audio-context`** — раз в 10с, пока открыт активный 1:1-звонок: `{ state }` (`AudioContext.state`). Это контекст АНАЛИЗАТОРА волны (визуализация), не путь воспроизведения — см. `call-overlay.jsx`.
- **`sw-update-found`** — обнаружена новая версия service worker.
- **`sw-reload`** — `{ reason: "controllerchange" }` — записывается **до** `location.reload()` (иначе факт терялся бы вместе с незаписанным хвостом буфера).
- **`sw-trace:install`** / **`sw-trace:activate`** — соответствующие события жизненного цикла самого service worker (постим через `postMessage`, т.к. `service-worker.js` не проходит сборку и не может импортировать этот модуль).
- **`page-reload`** — служебное событие самого трассировщика, см. ниже.

## Переживание перезагрузки (`page-reload`)

Буфер сбрасывается в `localStorage` (ключ `ugolok.diag.trace.v1`) раз в 5с и
дополнительно по `pagehide`/уходу вкладки в фон. При следующей загрузке
вкладки (если флаг всё ещё включён — он живёт в `sessionStorage`, значит
переживает форс-релоад service worker, но не переживает закрытие вкладки),
модуль восстанавливает предыдущее содержимое буфера и добавляет запись:

```json
{ "ev": "page-reload", "sid": "<новый sid>", "payload": { "restoredEntries": 42 } }
```

Так сама перезагрузка (в том числе принудительная, от `service-worker.js`)
становится видимой в файле — можно отличить «звонок оборвался из-за сети» от
«вкладку перезагрузило деплоем».

## Сшивка двух сторон

Оба участника снимают трассировку (флаг `?diag=1` включается независимо на
каждом устройстве). Сшивка — по полю `t` (UTC ISO), с поправкой на возможный
сдвиг часов устройств (не измеряется автоматически — см. открытый пункт в
отчёте по задаче). `sid` разделяет записи РАЗНЫХ загрузок вкладки на одном
устройстве (например, до и после `page-reload`), `pc` — записи разных
`RTCPeerConnection` (например, разных попыток ICE-рестарта или разных рёбер
меша в комнате).

Готового скрипта сшивки (`scripts/diag/merge-traces.mjs` из первого аудиторского
ТЗ) в этой задаче не делалось — не входило в scope `TZ-diag-trace.md`.
