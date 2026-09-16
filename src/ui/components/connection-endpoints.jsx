import { useState, useEffect } from "preact/hooks";
import { t } from "../signals/i18n.js";
import IconChevronDown from "../icons/chevron-down.jsx";
import {
	readBootstrapEndpoints,
	writeBootstrapEndpoints,
	resetBootstrapEndpoints,
	parseRelayUrl,
	parseBlossomUrl,
	parseIceUrl,
	iceUrlFromServers,
	resolveCallIceServers,
} from "../../domain/settings/bootstrap-endpoints.js";
import { loadRuntimeConfig, getRuntimeConfig } from "../../domain/settings/runtime-config.js";
import { probeRelay, probeBlossom, probeIce, withRetry } from "../../core/transport/endpoint-health.js";

const DEBOUNCE_MS = 350;

// Живая проверка нестабильна не потому, что контейнеры на сервере правда
// то падают, то поднимаются — а потому что раньше каждая проба (relay/
// blossom/turn) делалась РОВНО один раз за загрузку страницы: одна неудача
// (тесный таймаут, TURN-аллокация не успела) сразу фиксировалась как "bad"
// до следующей полной перезагрузки. withRetry() ниже даёт каждой пробе
// несколько попыток, прежде чем сдаться.
const HEALTH_CACHE_KEY = "ugolok.connHealthCache.v1";
// Короткий TTL нарочно: это подсказка "как было в прошлый раз", а не
// источник истины — свежая проверка всё равно всегда запускается и
// перезапишет это значение через ~DEBOUNCE_MS.
const HEALTH_CACHE_TTL_MS = 2 * 60 * 1000;

function readHealthCache() {
	try {
		const store = globalThis.sessionStorage;
		const raw = store?.getItem(HEALTH_CACHE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Date.now() - (parsed.savedAt || 0) > HEALTH_CACHE_TTL_MS) return {};
		return parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
	} catch {
		return {};
	}
}

function writeHealthCacheEntry(kind, value, state) {
	try {
		const store = globalThis.sessionStorage;
		if (!store) return;
		let parsed = null;
		try {
			const raw = store.getItem(HEALTH_CACHE_KEY);
			parsed = raw ? JSON.parse(raw) : null;
		} catch {
			parsed = null;
		}
		const fresh = parsed && Date.now() - (parsed.savedAt || 0) <= HEALTH_CACHE_TTL_MS;
		const entries = fresh ? { ...parsed.entries } : {};
		entries[kind] = { value, state: state.state, ms: state.ms ?? null };
		store.setItem(HEALTH_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), entries }));
	} catch {
		// quota / приватный режим
	}
}

// Последний известный статус (если он для того же значения поля и не
// протух) вместо "idle" при монтировании — чтобы при перезагрузке страницы
// пользователь сразу видел прошлый результат, а не мигание
// idle → checking → bad/ok на каждый заход.
function cachedHealthFor(cache, kind, value) {
	const entry = cache[kind];
	if (entry && entry.value === value && (entry.state === "ok" || entry.state === "bad")) {
		return { state: entry.state, ms: entry.ms ?? null };
	}
	return { state: "idle", ms: null };
}

function shortHost(url) {
	return String(url || "")
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/^[a-z]+:/i, "");
}

function latencyClass(ms) {
	if (ms == null) return "";
	if (ms < 50) return "endpoint-latency--good";
	if (ms < 150) return "endpoint-latency--warn";
	return "endpoint-latency--bad";
}

function statusKey(state) {
	if (state === "checking") return "unlock.main.connection.statusChecking";
	if (state === "ok") return "unlock.main.connection.statusOk";
	if (state === "bad") return "unlock.main.connection.statusBad";
	return "unlock.main.connection.statusIdle";
}

// Живой пере-опрос — только для relay/blossom (то, от чего зависит сводная
// плашка), только пока вкладка видима, с джиттером и экспоненциальным
// backoff при неудаче. TURN сюда намеренно не включён: самая тяжёлая
// проверка (config.json + TURN-креды + реальная ICE-аллокация на coturn) и
// с прошлого фикса уже не влияет на сводный статус — гонять её в фоне для
// тысяч одновременно открытых вкладок смысла нет.
const POLL_BASE_MS = 45_000;
const POLL_JITTER_MS = 15_000;
const POLL_MAX_MS = 5 * 60_000;

function pollDelay(backoffMs) {
	return backoffMs + Math.random() * POLL_JITTER_MS;
}

function isVisible() {
	const doc = globalThis.document;
	return !doc || doc.visibilityState !== "hidden";
}

function useDebouncedProbe(value, parse, probe, onHealth, { poll = false } = {}) {
	useEffect(() => {
		let cancelled = false;
		let pollTimer = null;
		// Backoff растёт при неудаче (реже дёргаем упавший сервис, а не чаще) и
		// сбрасывается на POLL_BASE_MS при первой же удачной проверке.
		let backoffMs = POLL_BASE_MS;

		function stopPoll() {
			if (pollTimer) {
				clearTimeout(pollTimer);
				pollTimer = null;
			}
		}

		function schedulePoll() {
			stopPoll();
			if (!poll || cancelled || !isVisible()) return;
			pollTimer = setTimeout(runPoll, pollDelay(backoffMs));
		}

		async function runPoll() {
			if (cancelled || !isVisible()) return;
			const parsed = parse(value);
			if (!parsed) return;
			// Один заход за тик — без внутренних ретраев: сам интервал между
			// тиками (плюс backoff при неудаче) уже даёт сервису право на вторую
			// попытку, не нужно устраивать всплеск из нескольких запросов разом.
			const result = await probe(parsed);
			if (cancelled) return;
			backoffMs = result.ok ? POLL_BASE_MS : Math.min(backoffMs * 2, POLL_MAX_MS);
			onHealth({ state: result.ok ? "ok" : "bad", ms: result.ok ? result.ms : null });
			schedulePoll();
		}

		function onVisibilityChange() {
			// Вкладка была свёрнута, пока таймер молчал — пользователь мог не
			// увидеть, что сервис успел упасть и подняться; перепроверяем сразу
			// при возврате, а не ждём остаток интервала вслепую.
			if (isVisible() && !pollTimer && !cancelled) runPoll();
		}

		const timer = setTimeout(async () => {
			const parsed = parse(value);
			if (!parsed) {
				if (!cancelled) onHealth({ state: String(value).trim() ? "bad" : "idle", ms: null, invalid: Boolean(String(value).trim()) });
				return;
			}
			onHealth({ state: "checking", ms: null });
			const result = await withRetry(() => probe(parsed), { isCancelled: () => cancelled });
			if (cancelled) return;
			backoffMs = result.ok ? POLL_BASE_MS : Math.min(POLL_BASE_MS * 2, POLL_MAX_MS);
			onHealth({ state: result.ok ? "ok" : "bad", ms: result.ok ? result.ms : null });
			schedulePoll();
		}, DEBOUNCE_MS);

		if (poll) globalThis.document?.addEventListener?.("visibilitychange", onVisibilityChange);

		return () => {
			cancelled = true;
			clearTimeout(timer);
			stopPoll();
			if (poll) globalThis.document?.removeEventListener?.("visibilitychange", onVisibilityChange);
		};
	}, [value]);
}

export default function ConnectionEndpoints() {
	const initial = readBootstrapEndpoints();
	const initialTurn = iceUrlFromServers(initial.iceServers);
	const [relay, setRelay] = useState(initial.relayUrl);
	const [blossom, setBlossom] = useState(initial.blossomUrl);
	const [turn, setTurn] = useState(initialTurn);
	const [health, setHealth] = useState(() => {
		const cache = readHealthCache();
		return {
			relay: cachedHealthFor(cache, "relay", initial.relayUrl),
			blossom: cachedHealthFor(cache, "blossom", initial.blossomUrl),
			turn: cachedHealthFor(cache, "turn", initialTurn),
		};
	});

	function patch(kind, next, value) {
		setHealth((h) => ({ ...h, [kind]: next }));
		if (value != null && (next.state === "ok" || next.state === "bad")) {
			writeHealthCacheEntry(kind, value, next);
		}
	}

	useDebouncedProbe(
		relay,
		parseRelayUrl,
		(url) => {
			writeBootstrapEndpoints({ relayUrl: url });
			return probeRelay(url);
		},
		(next) => patch("relay", next, relay),
		{ poll: true },
	);
	useDebouncedProbe(
		blossom,
		parseBlossomUrl,
		(url) => {
			writeBootstrapEndpoints({ blossomUrl: url });
			return probeBlossom(url);
		},
		(next) => patch("blossom", next, blossom),
		{ poll: true },
	);
	useEffect(() => {
		let cancelled = false;
		const timer = setTimeout(async () => {
			const parsed = parseIceUrl(turn);
			if (!parsed) {
				if (!cancelled) patch("turn", { state: String(turn).trim() ? "bad" : "idle", ms: null, invalid: Boolean(String(turn).trim()) });
				return;
			}
			const current = readBootstrapEndpoints();
			const displayed = iceUrlFromServers(current.iceServers);
			if (displayed !== parsed.urls) {
				writeBootstrapEndpoints({ iceServers: [parsed] });
			}
			if (!cancelled) patch("turn", { state: "checking", ms: null });
			// TURN-цепочка длиннее и медленнее relay/blossom (config.json → TURN-
			// креды → реальная ICE-аллокация на coturn), поэтому именно она чаще
			// всего "не успевала" за один заход. withRetry() перезапускает всю
			// цепочку целиком — config.json и TURN-креды кэшируются внутри своих
			// модулей (getRuntimeConfig/cachedTurnCreds), так что повторные попытки
			// не бьют по сети лишний раз, когда первый шаг уже удался.
			const result = await withRetry(
				async () => {
					// Живая проверка (прод, 2026-09-06) — этот виджет виден ДО входа, а
					// loadRuntimeConfig() до этого момента вызывает только connect() (после
					// разблокировки). getRuntimeConfig().turnCredentialsUrl на этом экране
					// был бы всегда пуст (кэш ещё не заполнен), и resolveCallIceServers()
					// молча уходил бы в ветку "нет turnCredentialsUrl" — тот же голый
					// список без кредов, что и раньше. Дожидаемся здесь явно.
					if (!getRuntimeConfig().turnCredentialsUrl) {
						await loadRuntimeConfig();
					}
					// Проверяем тем же путём, что и реальный звонок (resolveCallIceServers,
					// media-controller.js) — не голым parsed/current.iceServers: этап 6
					// (TZ-cicd-hardening) не кладёт TURN-креды в config.json намеренно,
					// RTCPeerConnection с turn: без username/credential бросает
					// InvalidAccessError синхронно (живая проверка, прод, 2026-09-06).
					const iceForProbe = await resolveCallIceServers();
					return probeIce(iceForProbe);
				},
				{ attempts: 2, delayMs: 900, isCancelled: () => cancelled },
			);
			if (!cancelled) patch("turn", { state: result.ok ? "ok" : "bad", ms: result.ok ? result.ms : null }, turn);
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [turn]);

	function handleReset() {
		resetBootstrapEndpoints();
		const next = readBootstrapEndpoints();
		setRelay(next.relayUrl);
		setBlossom(next.blossomUrl);
		setTurn(iceUrlFromServers(next.iceServers));
	}

	// Сводная плашка ("все сервисы в порядке") завязана только на relay и
	// blossom — это то, что реально нужно, чтобы войти и переписываться. TURN
	// нужен только звонкам, а его проверка — самая долгая и по своей природе
	// нестабильная (реальная ICE-аллокация на coturn, не просто HTTP-пинг):
	// раньше одна её случайная неудача красила весь заголовок в "недоступно",
	// хотя логин и сообщения при этом работали как обычно. Статус TURN
	// по-прежнему виден отдельным индикатором в развёрнутом списке ниже.
	const coreStates = [health.relay.state, health.blossom.state];
	let summaryKey = "unlock.main.connection.summaryLocal";
	let summaryTone = "";
	if (coreStates.some((s) => s === "checking")) {
		summaryKey = "unlock.main.connection.summaryChecking";
		summaryTone = "checking";
	} else if (coreStates.some((s) => s === "bad")) {
		summaryKey = "unlock.main.connection.summaryBad";
		summaryTone = "bad";
	} else if (coreStates.every((s) => s === "ok")) {
		summaryKey = "unlock.main.connection.summaryOk";
		summaryTone = "ok";
	}

	return (
		<section class="unlock-conn" aria-label={t("unlock.main.connection.ariaLabel")}>
			<details>
				<summary>
					<div class="unlock-conn-main">
						<div class="unlock-conn-title">
							{t("unlock.main.connection.title")}
							<span class={`endpoint-status${summaryTone ? ` endpoint-status--${summaryTone}` : ""}`}>
								<span class="endpoint-status-dot" aria-hidden="true" />
								{t(summaryKey)}
							</span>
						</div>
						<div class="unlock-conn-sub">
							{t("unlock.main.connection.relayLabel")} · {t("unlock.main.connection.blossomLabel")} · {t("unlock.main.connection.turnLabel")}
							{relay ? ` · ${shortHost(relay)}` : ""}
						</div>
					</div>
					<span class="unlock-conn-chevron" aria-hidden="true">
						<IconChevronDown />
					</span>
				</summary>
				<div class="unlock-conn-body">
					<p class="unlock-conn-intro">{t("unlock.main.connection.intro")}</p>
					<EndpointField
						kind="relay"
						label={t("unlock.main.connection.relayLabel")}
						placeholder={t("unlock.main.connection.relayPlaceholder")}
						value={relay}
						health={health.relay}
						invalidHint={t("unlock.main.connection.invalidRelay")}
						onInput={setRelay}
					/>
					<EndpointField
						kind="blossom"
						label={t("unlock.main.connection.blossomLabel")}
						placeholder={t("unlock.main.connection.blossomPlaceholder")}
						value={blossom}
						health={health.blossom}
						invalidHint={t("unlock.main.connection.invalidBlossom")}
						onInput={setBlossom}
					/>
					<EndpointField
						kind="turn"
						label={t("unlock.main.connection.turnLabel")}
						placeholder={t("unlock.main.connection.turnPlaceholder")}
						value={turn}
						health={health.turn}
						invalidHint={t("unlock.main.connection.invalidTurn")}
						onInput={setTurn}
					/>
					<div class="unlock-conn-reset">
						<button type="button" onClick={handleReset}>
							{t("unlock.main.connection.resetDefaults")}
						</button>
					</div>
				</div>
			</details>
		</section>
	);
}

function EndpointField({ kind, label, placeholder, value, health, invalidHint, onInput }) {
	const id = `unlock-endpoint-${kind}`;
	let hint;
	if (health.invalid) hint = invalidHint;
	else if (health.state === "ok" && health.ms != null) {
		hint = <strong class={latencyClass(health.ms)}>{t("unlock.main.connection.latency", { ms: health.ms })}</strong>;
	} else if (health.state === "bad") hint = t("unlock.main.connection.hintBad");
	else if (health.state === "checking") hint = t("unlock.main.connection.statusChecking");
	else hint = t("unlock.main.connection.hintIdle");

	return (
		<div class={`unlock-svc${health.state === "ok" ? " is-ok" : health.state === "bad" ? " is-bad" : health.state === "checking" ? " is-checking" : ""}`}>
			<div class="unlock-svc-head">
				<label class="unlock-svc-label" for={id}>
					{label}
				</label>
				<span class={`endpoint-status${health.state !== "idle" ? ` endpoint-status--${health.state}` : ""}`}>
					<span class="endpoint-status-dot" aria-hidden="true" />
					{t(statusKey(health.state))}
				</span>
			</div>
			<input
				id={id}
				class="unlock-svc-input"
				type="url"
				inputMode="url"
				spellcheck={false}
				autocomplete="off"
				placeholder={placeholder}
				value={value}
				onInput={(e) => onInput(e.currentTarget.value)}
			/>
			<small class="unlock-svc-meta">{hint}</small>
		</div>
	);
}
