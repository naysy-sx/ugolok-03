# ТЗ: экран «Диагностика» — переписывается с нуля (вариант Б)

**Куда положить файл:** `PROCESS-DOCS/REDESIGN/DIAGNOSTICS-REDESIGN.md`
**Референс-макет:** `diagnostics-B.html`
**Словарь оформительского слоя:** `PROCESS-DOCS/MOLECULES.md` — прочитай
его до начала. Всё, что можно собрать из существующих молекул, собирается
из них; новые классы в §7 заведены только там, где ни одна не подошла.

---

## 0. Правила работы для исполнителя

1. **Не импровизируй.** Полный текст новых файлов приведён ниже. Вставляй
   как есть. Замечания — отдельным списком в конце отчёта, после того как
   сделаешь по ТЗ.
2. **Не расширяй область работы.** Список файлов — §1.
3. **Не выдумывай данные.** Всё, что показывает экран, обязано браться из
   реально существующего источника. Источник каждого числа назван в §2. Ни
   одного значения «примерно» или «пока заглушка» в коде быть не должно:
   если данных нет, показывается явное «неизвестно», а не правдоподобная
   цифра.
4. **Регламент раскладки обязателен** — `PROCESS-DOCS/REGLAMENT.md`.
   Композиция параметризуется через `--gap`, `--align` (параметр введён
   в предыдущем цикле — использовать его, а не инлайновый `alignItems`).
5. **Порядок этапов строгий:** §3 → §4 → §5 → §6 → §7 → §8 → §9.
   После каждого — `npm test`.
6. Комментарии в коде — на русском, объясняют ПРИЧИНУ.

---

## 1. Файлы

| Файл | Что с ним |
|---|---|
| `src/core/diag/boot-log.js` | **новый** — кольцевой буфер журнала загрузки (§3) |
| `src/core/transport/relay-pool.js` | добавляется `getMembers()` (§4) |
| `src/ui/signals/transport.js` | пробрасывается `getRelayMembers()`, пишется в журнал (§4) |
| `src/ui/signals/diagnostics.js` | **новый** — сбор всех показателей (§5) |
| `src/ui/screens/diagnostics.jsx` | **переписывается целиком** (§6) |
| `src/styles/custom.css` | новый блок (§7) |
| `src/ui/i18n/locales/*.json` (все 12) | новый узел `diagnostics` (§8) |
| `src/app.jsx`, `src/main.jsx` | по одной строке инструментирования (§3.2) |
| `tests/boot-log.test.js` | **новый** (§9) |

---

## 2. Что показывает экран и откуда берётся каждое число

Прежний экран отвечал на вопрос «прошли ли этапы разработки»: двадцать
пять строк вида «Этап 15 · P-SPIKE (5000 событий)». Номер этапа ничего не
говорит человеку, который не читал `PLAN.md`. Новый отвечает на вопрос
«всё ли в порядке, и если нет — что делать».

| Показатель | Источник | Есть сейчас? |
|---|---|---|
| Состояние каждого реле | `getMembers()` пула (§4) | нет, добавляется |
| Задержка до реле | замер вокруг `fetchFromRelay` (§5.2) | нет, добавляется |
| Время с последней синхронизации | `synced` + отметка времени в `transport.js` | частично |
| Место на этом устройстве | `navigator.storage.estimate()` | **да, бесплатно** |
| Место в хранилище Blossom | **ИСТОЧНИКА НЕТ** — см. §10 п.1 | нет |
| Журнал загрузки | новый `boot-log.js` (§3) | нет |
| Проверки движка | существующие хуки из старого файла | да |
| Расхождения переписок | существующий `useDesyncedChats` | да |
| Сборка, схема БД, браузер | `BUILD_HASH`, `db.verno`, `navigator.userAgent` | да |

**Плитка «занято на сервере» в этом этапе НЕ реализуется.** В
`blossom-client.js` есть только `uploadBlob`/`downloadBlob`/`deleteBlob`/
`checkUploadRequirements` — ни объёма, ни лимита. Вместо числа выводится
`t("diagnostics.metrics.storageUnknown")` и подпись, что сервер пока не
сообщает лимит. Не подставляй туда сумму размеров из `files_nodes`: это
«что я загрузил с этого устройства», а не «что занято на сервере», и
разница будет молча врать в большую или меньшую сторону в зависимости от
того, с какого устройства человек смотрит.

---

## 3. Новый файл `src/core/diag/boot-log.js`

### 3.1. Содержимое

```js
// Журнал загрузки — кольцевой буфер В ПАМЯТИ, не в базе. Хранить его в
// IndexedDB было бы неверно по существу: журнал описывает ТЕКУЩИЙ запуск
// приложения, и запись прошлого запуска в нём вводила бы в заблуждение
// ("почему реле не отвечало?" — а это было вчера). Живёт от загрузки
// страницы до перезагрузки, ровно как и предмет описания.
//
// Размер ограничен жёстко: экран диагностики может быть открыт часами, а
// переподключения к реле пишутся сюда каждый раз. Без потолка это утечка.
const MAX_ENTRIES = 200;

const entries = [];
const listeners = new Set();
const startedAt = Date.now();

function push(level, message) {
	entries.push({ at: Date.now() - startedAt, level, message });
	if (entries.length > MAX_ENTRIES) entries.shift();
	for (const listener of listeners) listener();
}

// level: "info" | "warn" | "error". Разделение нужно не для цвета, а для
// счётчика проблем на экране — "сколько всего записей" бесполезно,
// "сколько из них тревожных" отвечает на вопрос человека.
export function logInfo(message) {
	push("info", message);
}

export function logWarn(message) {
	push("warn", message);
}

export function logError(message) {
	push("error", message);
}

export function getBootLog() {
	return entries.slice();
}

export function countProblems() {
	return entries.filter((e) => e.level !== "info").length;
}

// Подписка для UI. Возвращает функцию отписки — обязательна, иначе
// размонтированный экран диагностики продолжит держать ссылку и
// перерисовываться в фоне при каждом переподключении реле.
export function subscribeBootLog(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

// Только для тестов — в приложении журнал не сбрасывается никогда.
export function resetBootLogForTests() {
	entries.length = 0;
	listeners.clear();
}
```

### 3.2. Места вызова — ровно семь, ни одним больше

Расставь именно эти вызовы и ничего сверх. Каждый — одна строка рядом с
уже существующим кодом, ничего не переставляй.

| Файл | Куда | Вызов |
|---|---|---|
| `src/main.jsx` | самая первая строка после импортов | `logInfo(\`запуск, сборка ${BUILD_HASH}\`);` |
| `src/main.jsx` | в обработчике успешной регистрации service worker | `logInfo("service worker зарегистрирован");` |
| `src/core/store/database.js` | в `db.on("ready", …)`, если такого обработчика нет — добавь его | `logInfo(\`база данных открыта, схема ${db.verno}\`);` |
| `src/ui/signals/transport.js` | в `onStateChange` пула, ветка перехода в `connected` | `logInfo(\`${url} — соединение установлено\`);` |
| `src/ui/signals/transport.js` | там же, ветка перехода в `disconnected` | `logWarn(\`${url} — соединение потеряно\`);` |
| `src/ui/signals/transport.js` | по завершении первичной синхронизации (там, где `synced.value = true`) | `logInfo(\`синхронизация завершена\`);` |
| `src/ui/signals/auth.js` | после успешной расшифровки ключей | `logInfo("ключи расшифрованы");` |

Если в `onStateChange` пула сейчас нет `url` конкретного соединения (он
агрегирующий) — это чинится в §4, сделай сначала §4.

**Не патчь `console.warn`/`console.error`** ради автоматического сбора.
Соблазнительно и дало бы больше записей одной строкой, но глобальный
патч консоли ловит и чужие предупреждения (браузера, библиотек), которые
человек прочтёт как проблемы своего приложения. См. §10 п.3.

---

## 4. Состояние по каждому реле

### 4.1. `src/core/transport/relay-pool.js`

Пул возвращает только агрегат (`getState`) и склеенную строку урлов
(`getUrl`). Для экрана нужно состояние ПО КАЖДОМУ реле. Добавь в
возвращаемый объект `createRelayPool` (рядом с `getState`/`getUrl`):

```js
		// Диагностика: агрегат getState() отвечает "хоть что-то живо?", а
		// человеку на экране нужно "какое именно реле молчит". Отдаём копию
		// (map по connections), а не сами connection-объекты — снаружи пул
		// доступен только на чтение.
		getMembers: () =>
			entries.map((entry, i) => ({
				url: entry.url,
				read: !!entry.read,
				write: !!entry.write,
				state: connections[i].getState(),
			})),
```

Ничего другого в этом файле не менять.

### 4.2. `src/ui/signals/transport.js`

Экспортируй наружу:

```js
// Диагностика читает состояние пула, но не должна знать про переменную
// connection и её жизненный цикл (она пересоздаётся при смене настроек).
export function getRelayMembers() {
	return connection?.getMembers?.() ?? [];
}
```

И в существующем `onStateChange` пула добавь вызовы журнала из §3.2. Если
обработчик получает только агрегированное состояние, а не url — не
переписывай пул под это: логируй агрегат
(`logInfo("реле: соединение установлено")` / `logWarn("реле: связь
потеряна")`), а поимённое состояние экран и так возьмёт из
`getRelayMembers()`. Тратить правку пула на подробности журнала не надо.

---

## 5. Новый файл `src/ui/signals/diagnostics.js`

```js
import { useState, useEffect } from "preact/hooks";
import { fetchFromRelay } from "../../core/transport/relay-pool.js";
import { getRelayMembers } from "./transport.js";
import { getBootLog, countProblems, subscribeBootLog } from "../../core/diag/boot-log.js";

// Задержка меряется ОДНОРАЗОВЫМ соединением (fetchFromRelay), а не
// пингом по постоянному: постоянное уже открыто, и время до ответа на
// нём измеряет только загрузку реле, а не полный путь. Одноразовое
// меряет то, что человек и подразумевает под "быстро ли отвечает" —
// установку соединения плюс оборот запроса.
//
// Фильтр намеренно самый дешёвый из осмысленных: kind:0 (метаданные),
// limit 1. REQ, который реле обязано закрыть EOSE'ом почти сразу.
const PROBE_FILTER = [{ kinds: [0], limit: 1 }];
const PROBE_TIMEOUT_MS = 6000;

async function probeRelay(url) {
	const startedAt = performance.now();
	try {
		await fetchFromRelay(url, PROBE_FILTER, { timeoutMs: PROBE_TIMEOUT_MS });
		return { url, latencyMs: Math.round(performance.now() - startedAt) };
	} catch {
		return { url, latencyMs: null };
	}
}

// Замеры делаются ТОЛЬКО по явной команде и при открытии экрана — не по
// таймеру. Автообновление раз в N секунд открывало бы по одноразовому
// сокету на каждое реле каждые N секунд всё время, пока экран открыт;
// на экране, куда заходят "посмотреть, всё ли нормально", это чистый
// вред и лишний трафик.
export function useRelayStatus() {
	const [members, setMembers] = useState([]);
	const [latency, setLatency] = useState({});
	const [probing, setProbing] = useState(false);

	async function refresh() {
		const list = getRelayMembers();
		setMembers(list);
		if (list.length === 0) return;
		setProbing(true);
		try {
			const results = await Promise.all(list.map((m) => probeRelay(m.url)));
			setLatency(Object.fromEntries(results.map((r) => [r.url, r.latencyMs])));
		} finally {
			setProbing(false);
		}
	}

	useEffect(() => {
		refresh();
	}, []);

	return { members, latency, probing, refresh };
}

// Место на устройстве — единственный объём, который известен честно и
// без единой строчки серверного кода. estimate() отдаёт суммарно по
// IndexedDB и Cache Storage; ни в каком браузере он не точен до байта
// (спецификация прямо разрешает округление ради приватности), поэтому
// показываем как есть и не пытаемся сверять с суммой по таблицам.
export function useDeviceStorage() {
	const [state, setState] = useState({ supported: true, usage: null, quota: null });

	useEffect(() => {
		if (!navigator.storage?.estimate) {
			setState({ supported: false, usage: null, quota: null });
			return;
		}
		navigator.storage
			.estimate()
			.then((e) => setState({ supported: true, usage: e.usage ?? null, quota: e.quota ?? null }))
			.catch(() => setState({ supported: true, usage: null, quota: null }));
	}, []);

	return state;
}

export function useBootLog() {
	const [, force] = useState(0);
	useEffect(() => subscribeBootLog(() => force((n) => n + 1)), []);
	return { lines: getBootLog(), problems: countProblems() };
}

// Байты -> человекочитаемо. Отдельная функция, а не formatFileSize из
// domain/files: тот форматирует размер ФАЙЛА (нужна точность до
// килобайта), здесь речь о единицах гигабайт, и лишние знаки только
// мешают читать.
export function formatBytes(bytes) {
	if (bytes == null) return null;
	const units = ["Б", "КБ", "МБ", "ГБ"];
	let value = bytes;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i += 1;
	}
	return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
```

---

## 6. `src/ui/screens/diagnostics.jsx` — полная замена

### 6.1. Что из старого файла сохраняется

Перенеси в новый файл **побуквенно, без правок тела**:

- `function envChecks()` — проверка наличия критических браузерных API;
- `function useDesyncedChats()` — расхождения переписок;
- хуки проверок движка: `useDatabaseStatus`, `useCacheStatus`,
  `useCoreLogicStatus`, `useOutboxStatus`, `useReleaseHashStatus`,
  `useNip06Status`, `useKeystoreStatus`, `useSignCryptoStatus`,
  `useCryptoWorkerStatus`, `useServiceWorker`, `useTransportSyncCheck`
  и их функции `*Tone`.

### 6.2. Что удаляется

- `usePSpikeBenchmark` и вся строка «Этап 15 · P-SPIKE (5000 событий)».
  Это не диагностика, а нагрузочный тест: он прогоняет пять тысяч событий
  через обработку прямо в интерфейсе пользователя. Место такому — в
  `tests/`, а не на экране, куда «интересно заглянуть». Вместе с ним
  удаляется `pSpikeTone`.
- Компоненты `Row`, `StatusRow`, `Section` — их заменяют молекулы из
  `MOLECULES.md`.
- Строка с `<SyncIndicator …>` — состояние теперь показано поимённо по
  каждому реле, общий индикатор дублирует.
- **Инлайновое объявление `--ok`/`--bad`/`--warn` на обёртке.** Это
  найденный дефект: этап 70 завёл настоящие токены `--bad`/`--warn`/
  `--good` с парами `-surface`/`-edge` и пересчитанным под WCAG
  контрастом, а экран перекрывает их старыми литералами на всё своё
  поддерево. Обёртка не должна объявлять ни одного из этих трёх.
- Хардкод `<Screen title="Проверка движка">` и все русские строки в
  разметке — экран единственный в проекте не локализован вовсе (§8).

### 6.3. Новый `export default function Diagnostics()`

```jsx
export default function Diagnostics() {
	const checks = envChecks();
	const missingApis = checks.filter((c) => c.critical && !c.ok);

	const relays = useRelayStatus();
	const device = useDeviceStorage();
	const bootLog = useBootLog();
	const desynced = useDesyncedChats();

	const sw = useServiceWorker();
	const dbStatus = useDatabaseStatus();
	const cacheStatus = useCacheStatus();
	const coreLogicStatus = useCoreLogicStatus();
	const outboxStatus = useOutboxStatus();
	const releaseHashStatus = useReleaseHashStatus();
	const nip06Status = useNip06Status();
	const keystoreStatus = useKeystoreStatus();
	const signCryptoStatus = useSignCryptoStatus();
	const cryptoWorkerStatus = useCryptoWorkerStatus();
	const transportSync = useTransportSyncCheck();

	const onlineRelays = relays.members.filter((m) => m.state === "connected");
	const latencies = Object.values(relays.latency).filter((v) => v != null);
	const bestLatency = latencies.length ? Math.min(...latencies) : null;

	// Проблема — это то, что человек может либо исправить, либо обязан
	// знать. Отсутствие критического API и разошедшаяся переписка сюда
	// попадают; "service worker ещё не активен" — нет, это состояние, а
	// не проблема, и живёт в проверках движка.
	const problemCount = missingApis.length + desynced.chats.length;
	const verdictTone = problemCount > 0 ? "bad" : onlineRelays.length === 0 ? "warn" : "good";

	function copyReport() {
		const report = [
			`build ${BUILD_HASH}`,
			`db ${db.verno}`,
			navigator.userAgent,
			"",
			...relays.members.map((m) => `${m.url} — ${m.state} — ${relays.latency[m.url] ?? "—"} ms`),
			"",
			...bootLog.lines.map((l) => `${(l.at / 1000).toFixed(2)} [${l.level}] ${l.message}`),
		].join("\n");
		navigator.clipboard?.writeText(report);
	}

	return (
		<Screen title={t("diagnostics.title")}>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
				{/* Четыре плитки — весь ответ на вопрос "как дела" до первого
				    клика. Больше четырёх не добавлять: пятая превращает сводку
				    обратно в список, из которого этот экран и вытаскивали. */}
				<div class="metric-grid">
					<Metric
						tone={bestLatency == null ? "warn" : "good"}
						value={bestLatency == null ? t("diagnostics.metrics.noAnswer") : t("diagnostics.metrics.ms", { n: bestLatency })}
						label={t("diagnostics.metrics.relays", { online: onlineRelays.length, total: relays.members.length })}
					/>
					<Metric
						tone={device.usage == null ? null : "good"}
						value={device.usage == null ? t("diagnostics.metrics.unknown") : formatBytes(device.usage)}
						label={device.quota == null ? t("diagnostics.metrics.deviceNoQuota") : t("diagnostics.metrics.deviceOf", { total: formatBytes(device.quota) })}
					/>
					<Metric
						tone={null}
						value={t("diagnostics.metrics.storageUnknown")}
						label={t("diagnostics.metrics.storageServerHint")}
					/>
					<Metric
						tone={problemCount > 0 ? "bad" : "good"}
						value={String(problemCount)}
						label={t("diagnostics.metrics.problems")}
					/>
				</div>

				<Panel title={t("diagnostics.connectionTitle")} hint={t("diagnostics.connectionHint")} icon={IconGlobe}>
					{relays.members.length === 0 ? (
						<p class="panel__hint">{t("diagnostics.noRelays")}</p>
					) : (
						<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
							{relays.members.map((m) => (
								<div key={m.url} class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
									<div class="set-row__text bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
										<span class={`dot dot--${m.state === "connected" ? "good" : "warn"}`} aria-hidden="true" />
										<span class="truncate" style={{ "--lines": "1" }}>{m.url}</span>
									</div>
									<span class="gauge__legend rigid">
										{relays.latency[m.url] == null ? t("diagnostics.metrics.noAnswer") : t("diagnostics.metrics.ms", { n: relays.latency[m.url] })}
									</span>
								</div>
							))}
						</div>
					)}
					<div class="row" style={{ "--gap": "var(--space-s)" }}>
						<button type="button" class="btn--ghost rigid" disabled={relays.probing} onClick={relays.refresh}>
							{relays.probing ? t("diagnostics.probing") : t("diagnostics.probeAgain")}
						</button>
					</div>
				</Panel>

				<Panel title={t("diagnostics.storageTitle")} icon={IconServer}>
					<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
						<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
							<div class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
								<span class="set-row__text">{t("diagnostics.deviceStorage")}</span>
								<span class="gauge__legend rigid">
									{device.usage == null
										? t("diagnostics.metrics.unknown")
										: device.quota == null
											? formatBytes(device.usage)
											: t("diagnostics.metrics.ofTotal", { used: formatBytes(device.usage), total: formatBytes(device.quota) })}
								</span>
							</div>
							{device.usage != null && device.quota ? <Gauge used={device.usage} total={device.quota} /> : null}
						</div>

						{/* Лимит хранилища не показывается числом, пока сервер его не
						    сообщает. Подставить сюда сумму размеров из files_nodes
						    нельзя: это "загруженное с ЭТОГО устройства", а не
						    "занятое на сервере", и расхождение молча вводило бы в
						    заблуждение. См. §10 п.1. */}
						<p class="panel__hint">{t("diagnostics.serverStorageUnavailable")}</p>
					</div>
				</Panel>

				<Panel title={problemCount > 0 ? t("diagnostics.problemsTitleN", { count: problemCount }) : t("diagnostics.problemsTitle")} icon={IconShield}>
					{problemCount === 0 && <p class="panel__hint">{t("diagnostics.noProblems")}</p>}

					{missingApis.map((c) => (
						<p key={c.label} class="callout callout--bad">
							{t("diagnostics.missingApi", { name: c.label })}
						</p>
					))}

					{desynced.chats.map((c) => (
						<div key={c.contactPubkey} class="callout callout--bad row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
							<span class="grow">
								{t("diagnostics.desyncedChat", {
									name: profiles.value[c.contactPubkey]?.name || shortPubkey(c.contactPubkey),
									count: c.consecutiveDecryptFailures,
								})}
							</span>
							<button
								type="button"
								class="btn--ghost rigid"
								disabled={desynced.busyContact === c.contactPubkey}
								onClick={() => desynced.recreate(c.contactPubkey)}
							>
								{desynced.busyContact === c.contactPubkey ? t("diagnostics.recreating") : t("diagnostics.recreate")}
							</button>
						</div>
					))}
				</Panel>

				<div class="stack" style={{ "--gap": "var(--space-s)" }}>
					<details class="exceptions">
						<summary class="bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
							<IconChevronDown />
							{t("diagnostics.bootLogSummary", { count: bootLog.lines.length, problems: bootLog.problems })}
						</summary>
						<div class="exceptions__body">
							<div class="logview scroller stack" style={{ "--gap": "0" }}>
								{bootLog.lines.map((line, i) => (
									<div key={i} class={`logview__line${line.level === "info" ? "" : ` logview__line--${line.level === "warn" ? "warn" : "bad"}`}`}>
										<span class="logview__t">{(line.at / 1000).toFixed(2)}</span>
										<span>{line.message}</span>
									</div>
								))}
							</div>
						</div>
					</details>

					<details class="exceptions">
						<summary class="bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
							<IconChevronDown />
							{t("diagnostics.engineSummary")}
						</summary>
						<div class="exceptions__body">
							<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
								<EngineRow label={t("diagnostics.engine.crypto")} status={signCryptoStatus} tone={nip9Tone(signCryptoStatus)} />
								<EngineRow label={t("diagnostics.engine.keys")} status={`${nip06Status} · ${keystoreStatus}`} tone={keystoreTone(keystoreStatus)} />
								<EngineRow label={t("diagnostics.engine.worker")} status={cryptoWorkerStatus} tone={cryptoWorkerTone(cryptoWorkerStatus)} />
								<EngineRow label={t("diagnostics.engine.crdt")} status={coreLogicStatus} tone={coreLogicTone(coreLogicStatus)} />
								<EngineRow label={t("diagnostics.engine.database")} status={dbStatus} tone={dbTone(dbStatus)} />
								<EngineRow label={t("diagnostics.engine.outbox")} status={outboxStatus} tone={stage5Tone(outboxStatus)} />
								<EngineRow label={t("diagnostics.engine.serviceWorker")} status={`${sw} · ${cacheStatus}`} tone={cacheTone(cacheStatus)} />
								<EngineRow label={t("diagnostics.engine.release")} status={releaseHashStatus} tone={releaseHashTone(releaseHashStatus)} />
								<EngineRow
									label={t("diagnostics.engine.transport")}
									status={transportSync.status}
									tone={transportSyncTone(transportSync.status)}
									action={
										<button type="button" class="btn--ghost rigid" onClick={transportSync.run}>
											{t("diagnostics.check")}
										</button>
									}
								/>
							</div>
						</div>
					</details>
				</div>

				<p class="buildinfo">
					{t("diagnostics.buildLine", { hash: BUILD_HASH, schema: db.verno })} · {navigator.userAgent}{" "}
					<button type="button" class="btn--ghost" onClick={copyReport}>
						{t("diagnostics.copyReport")}
					</button>
				</p>
			</div>
		</Screen>
	);
}
```

### 6.4. Три вспомогательных компонента

Добавь перед `export default`:

```jsx
// Панель раздела — та же молекула, что в settings.jsx/profile.jsx
// (MOLECULES.md). НЕ заводи здесь свою: если понадобится общая, вынести
// её в отдельный модуль — но это отдельная задача, не эта.
function Panel({ title, hint, icon: Icon, children }) {
	return (
		<section class="panel stack" style={{ "--gap": "var(--space-m)" }}>
			<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
				<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					{Icon && <Icon />}
					{title}
				</h2>
				{hint && <p class="panel__hint">{hint}</p>}
			</div>
			{children}
		</section>
	);
}

// Плитка показателя. tone=null — когда числа нет и красить нечего;
// зелёная точка у неизвестного значения врала бы.
function Metric({ value, label, tone }) {
	return (
		<div class="metric stack" style={{ "--gap": "var(--space-3xs)" }}>
			<span class="metric__value bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
				{tone && <span class={`dot dot--${tone}`} aria-hidden="true" />}
				{value}
			</span>
			<span class="metric__label">{label}</span>
		</div>
	);
}

function Gauge({ used, total }) {
	const pct = Math.min(100, Math.round((used / total) * 100));
	const tone = pct >= 90 ? " gauge--bad" : pct >= 75 ? " gauge--warn" : "";
	return (
		<div class={`gauge${tone}`} role="img" aria-label={t("diagnostics.gaugeAria", { pct })}>
			<div class="gauge__fill" style={{ inlineSize: `${pct}%` }} />
		</div>
	);
}

function EngineRow({ label, status, tone, action }) {
	return (
		<div class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
			<div class="set-row__text bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
				<span class="dot" style={{ backgroundColor: tone }} aria-hidden="true" />
				<span>{label}</span>
			</div>
			<span class="gauge__legend rigid truncate" style={{ "--lines": "1" }}>
				{status}
			</span>
			{action}
		</div>
	);
}
```

### 6.5. Иконки

`IconGlobe` — новый файл `src/ui/icons/globe.jsx`, по образцу остальных
(`viewBox="0 0 15 15"`, `fill="currentColor"`, `class="icon"`,
`width/height="1em"`, `aria-hidden`), `d`:

```
M7.5 1a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM2.02 8h2.5c.06 1.6.38 3.02.87 4.03A5.51 5.51 0 0 1 2.02 8zm2.5-1h-2.5a5.51 5.51 0 0 1 3.37-4.03C4.9 3.98 4.58 5.4 4.52 7zM7.5 2.13c.63.55 1.2 2.2 1.28 4.87H6.22C6.3 4.33 6.87 2.68 7.5 2.13zM6.22 8h2.56c-.08 2.67-.65 4.32-1.28 4.87C6.87 12.32 6.3 10.67 6.22 8zm3.76 0h2.5a5.51 5.51 0 0 1-3.37 4.03c.49-1.01.81-2.43.87-4.03zm0-1c-.06-1.6-.38-3.02-.87-4.03A5.51 5.51 0 0 1 12.48 7h-2.5z
```

`IconServer`, `IconShield`, `IconChevronDown` уже есть в проекте.

---

## 7. `src/styles/custom.css`

Добавь в конец файла целиком, дословно:

```css
/* ================================================================== *
 *  СЛОВАРЬ экрана "Диагностика". Всё остальное на экране собрано из   *
 *  уже описанного в MOLECULES.md: .panel, .callout, .set-row/         *
 *  .set-list, .exceptions, .seg/.slice--on.                           *
 * ================================================================== */

/* ---- 1. Индикатор состояния ---------------------------------------
 * Точка вместо галочки/креста: символ ✓/✗/! в прежней вёрстке нёс тот
 * же смысл, что и цвет, и при этом сдвигал текст по базовой линии.    */
.dot {
	inline-size: 0.55rem;
	block-size: 0.55rem;
	border-radius: var(--radius-full);
	flex: none;
	background-color: var(--muted);
}
.dot--good { background-color: var(--good); }
.dot--warn { background-color: var(--warn); }
.dot--bad  { background-color: var(--bad); }

/* ---- 2. Вердикт ----------------------------------------------------
 * Единственная строка, ради которой человек сюда заходит. Использует
 * парные токены --*-surface / --*-edge (minimal.css, этап 70) — те же,
 * что .callout, но крупнее и с собственным тоном заливки.             */
.verdict {
	padding: var(--space-m);
	border-radius: var(--radius-lg);
	border: var(--border-width) solid var(--good-edge);
	background-color: var(--good-surface);
}
.verdict--warn { border-color: var(--warn-edge); background-color: var(--warn-surface); }
.verdict--bad  { border-color: var(--bad-edge);  background-color: var(--bad-surface); }
.verdict__title {
	font-family: var(--font-display);
	font-size: var(--step-1);
	letter-spacing: var(--heading-letter-spacing);
	margin-block: 0;
}
.verdict__hint { color: var(--muted); font-size: var(--step--1); margin-block: 0; }

/* ---- 3. Шкала заполнения ------------------------------------------
 * Место в хранилище — единственное число на экране, у которого есть
 * потолок, поэтому единственное, которому полагается полоса.          */
.gauge {
	block-size: 0.5rem;
	border-radius: var(--radius-full);
	background-color: var(--surface-raised);
	overflow: hidden;
}
.gauge__fill {
	block-size: 100%;
	border-radius: inherit;
	background-color: var(--accent);
}
.gauge--warn .gauge__fill { background-color: var(--warn); }
.gauge--bad  .gauge__fill { background-color: var(--bad); }
.gauge__legend {
	color: var(--muted);
	font-size: var(--step--2);
	font-variant-numeric: tabular-nums;
}

/* ---- 4. Плитка показателя (вариант Б) ------------------------------ */
.metric-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
	gap: var(--space-s);
}
.metric {
	padding: var(--space-s) var(--space-m);
	border: var(--border-width) solid var(--border);
	border-radius: var(--radius);
	background-color: var(--surface);
}
.metric__value {
	font-family: var(--font-display);
	font-size: var(--step-2);
	line-height: 1.1;
	font-variant-numeric: tabular-nums;
}
.metric__label { color: var(--muted); font-size: var(--step--2); }

/* ---- 5. Журнал загрузки -------------------------------------------
 * Моноширинный, с отдельной прокруткой — .scroller композиционный,
 * высоту задаёт этот класс (композиция размеров не знает).            */
.logview {
	max-block-size: 18rem;
	font-family: var(--font-mono);
	font-size: var(--step--2);
	line-height: 1.5;
}
.logview__line { display: flex; gap: var(--space-s); }
.logview__t { color: var(--muted); flex: none; font-variant-numeric: tabular-nums; }
.logview__line--warn { color: var(--warn); }
.logview__line--bad { color: var(--bad); }

/* ---- 6. Подвал со сведениями о сборке ------------------------------ */
.buildinfo {
	color: var(--muted);
	font-size: var(--step--2);
	word-break: break-all;
}
.buildinfo code { font-size: inherit; }
```

Ничего существующего в этом файле не меняй.

---

## 8. Локализация

Экран диагностики — **единственный в проекте, где строки захардкожены
по-русски**, включая заголовок `<Screen title="Проверка движка">`. Это
исправляется здесь целиком.

Добавь во все 12 файлов новый узел верхнего уровня. `ru.json`, дословно:

```json
"diagnostics": {
	"title": "Диагностика",
	"connectionTitle": "Соединение",
	"connectionHint": "Задержка — полный оборот запроса до реле и обратно, включая установку соединения.",
	"noRelays": "Реле не настроены.",
	"probeAgain": "Замерить снова",
	"probing": "Замеряю…",
	"storageTitle": "Хранилище",
	"deviceStorage": "На этом устройстве",
	"serverStorageUnavailable": "Сервер файлов пока не сообщает, сколько места занято и сколько выделено.",
	"gaugeAria": "Занято {{pct}} процентов",
	"problemsTitle": "Что требует внимания",
	"problemsTitleN": "Что требует внимания · {{count}}",
	"noProblems": "Сейчас ничего. Здесь появляется только то, что вы можете исправить сами.",
	"missingApi": "Браузер не поддерживает «{{name}}» — часть приложения работать не будет.",
	"desyncedChat": "Переписка с «{{name}}» разошлась на два состояния: {{count}} сообщений подряд не расшифровались. Пересоздание восстановит переписку, но нерасшифрованные сообщения не вернутся.",
	"recreate": "Пересоздать",
	"recreating": "Пересоздаю…",
	"bootLogSummary": "Журнал загрузки · записей {{count}}, из них тревожных {{problems}}",
	"engineSummary": "Проверки движка",
	"check": "Проверить",
	"copyReport": "Скопировать отчёт",
	"buildLine": "Сборка {{hash}} · схема базы {{schema}}",
	"metrics": {
		"ms": "{{n}} мс",
		"noAnswer": "нет ответа",
		"unknown": "неизвестно",
		"relays": "быстрейшее реле · на связи {{online}} из {{total}}",
		"deviceOf": "занято на устройстве из {{total}}",
		"deviceNoQuota": "занято на устройстве",
		"storageUnknown": "—",
		"storageServerHint": "занято на сервере файлов",
		"problems": "требует внимания"
	},
	"engine": {
		"crypto": "Криптография",
		"keys": "Ключи и деривация",
		"worker": "Шифрование файлов",
		"crdt": "Слияние состояний",
		"database": "База данных",
		"outbox": "Очередь отправки",
		"serviceWorker": "Офлайн-режим и кэш",
		"release": "Целостность сборки",
		"transport": "Реле и синхронизация"
	}
}
```

`en.json` — перевести; остальные 10 (`es, de, ja, fr, pt, it, nl, pl, tr,
zh`) — тоже, сохранив ИМЕНА ключей один в один.

Обрати внимание: названия в узле `engine` — **не** «Этап 4», «Этап 9»,
«Этапы 16-20». Номер этапа разработки не значит ничего для человека,
который не читал `PLAN.md`; для тебя соответствие такое: crypto = этап 9,
keys = этапы 7+8, worker = этап 10, crdt = этап 4, outbox = этап 5,
release = этап 6, transport = этапы 16-20.

Множественного числа здесь нет нигде намеренно: `{{count}}` везде стоит
после разделителя как счётчик, а не согласуется с существительным.

Тест `tests/i18n.test.js` требует идентичного набора путей во всех 12
файлах — он и поймает пропуск.

---

## 9. Тесты

Новый `tests/boot-log.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { logInfo, logWarn, logError, getBootLog, countProblems, subscribeBootLog, resetBootLogForTests } from "../src/core/diag/boot-log.js";

test("boot-log: countProblems считает только warn и error", () => {
	resetBootLogForTests();
	logInfo("a");
	logInfo("b");
	logWarn("c");
	logError("d");
	assert.equal(getBootLog().length, 4);
	assert.equal(countProblems(), 2);
});

test("boot-log: буфер не растёт бесконечно", () => {
	resetBootLogForTests();
	for (let i = 0; i < 500; i += 1) logInfo(`line ${i}`);
	const lines = getBootLog();
	assert.equal(lines.length, 200);
	assert.equal(lines.at(-1).message, "line 499");
});

test("boot-log: отписка перестаёт получать уведомления", () => {
	resetBootLogForTests();
	let calls = 0;
	const unsubscribe = subscribeBootLog(() => {
		calls += 1;
	});
	logInfo("a");
	unsubscribe();
	logInfo("b");
	assert.equal(calls, 1);
});
```

---

## 10. Открытые вопросы — НЕ реализовывать

1. **Квота Blossom.** Ни занятого объёма, ни лимита протокол не даёт, а
   клиент не умеет даже BUD-02 `/list/<pubkey>`. Плитка и строка в панели
   показывают явное «сервер пока не сообщает». Отдельная задача: ручка на
   стороне сервера + `listBlobs()` в `blossom-client.js`.
2. **Автообновление замеров по таймеру** не делается сознательно (см.
   комментарий в §5). Замер — по открытию экрана и по кнопке.
3. **Перехват `console.warn`/`console.error`** в журнал загрузки не
   делается: глобальный патч консоли собрал бы и чужие предупреждения
   браузера и библиотек, которые человек прочтёт как проблемы своего
   приложения.
4. **`usePSpikeBenchmark` удаляется, а не переносится в `tests/`.**
   Перенос нагрузочного теста в тестовый набор — правильный шаг, но это
   отдельная задача со своим бюджетом времени выполнения тестов.
5. **`Panel` дублируется** в `settings.jsx`, `profile.jsx`,
   `security.jsx` и теперь `diagnostics.jsx`. Вынос в общий компонент —
   отдельная задача; пока молекула описана в `MOLECULES.md`, дублирование
   разметки допустимо и заметно.

---

## 11. Приёмка

Отчитайся по каждому пункту явным «да»/«нет»:

- [ ] `npm test` — зелёный, включая `i18n.test.js` и новый `boot-log.test.js`
- [ ] `npm run build` — проходит, бюджет бандла не превышен
- [ ] `grep -rn "Этап [0-9]" src/ui/screens/diagnostics.jsx` — пусто
- [ ] `grep -rn "P-SPIKE\|pSpike" src/` — пусто
- [ ] `grep -n '"--ok"\|--ok:' src/ui/screens/diagnostics.jsx` — пусто
- [ ] В `diagnostics.jsx` нет ни одной строки русского текста вне комментариев
- [ ] В `diagnostics.jsx` нет `alignItems` в инлайн-стилях — только `--align`
- [ ] Ровно один `.scroller` на пути от `.shell` до листа **кроме** `.logview`
      (у журнала своя прокрутка внутри свёрнутого блока — это осознанное
      исключение, проверь, что внешняя прокрутка экрана при этом работает)
- [ ] Визуально: четыре плитки, на узком контейнере они перестраиваются в
      одну колонку без обрезки
- [ ] Визуально: при нуле проблем панель «Что требует внимания» не пустая,
      а с объясняющей строкой
- [ ] Замер задержки: кнопка «Замерить снова» блокируется на время замера
      и разблокируется даже при таймауте всех реле
- [ ] Экран открывается без входа в учётную запись (реле не подключены) и
      не падает: плитки показывают «нет ответа»/«неизвестно»
