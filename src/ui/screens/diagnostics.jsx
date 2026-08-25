import { useState, useEffect } from "preact/hooks";
import { BUILD_HASH, BUILD_DEFAULT_RELAYS as DEFAULT_RELAYS } from "../../config.js";
import { db } from "../../core/store/database.js";
import { validateEventId } from "../../domain/events/validators.js";
import { mergeEvent } from "../../core/sync/g-set.js";
import { lwwWinner } from "../../core/sync/lww.js";
import { enqueue, listPending, markSent } from "../../core/store/outbox.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { mnemonicToPrivateKey } from "../../core/crypto/mnemonic.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { deriveMasterSecret, deriveDbKey, opaqueDTag } from "../../core/crypto/derivation.js";
import { encryptAndStore, decryptPrivateKey } from "../../core/crypto/keystore.js";
import { generateSecretKey, getPublicKey as nostrGetPublicKey } from "nostr-tools/pure";
import { sign, verify } from "../../core/crypto/sign.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "../../core/crypto/nip44.js";
import { wrap as nip59Wrap, unwrap as nip59Unwrap } from "../../core/crypto/nip59.js";
import * as Comlink from "comlink";
import CryptoWorker from "../../workers/crypto.worker.js?worker&inline";
import { createRelayConnection } from "../../core/transport/relay-pool.js";
import { createPublisher } from "../../core/transport/publisher.js";
import { runBootstrap } from "../../core/sync/bootstrap.js";
import { startIncrementalSync } from "../../core/sync/incremental-sync.js";
import { buildProfileEvent } from "../../domain/identity/profile.js";
import { buildRelayListEvent } from "../../domain/identity/relay-list.js";
import { useRelayStatus, useDeviceStorage, useBootLog, formatBytes } from "../signals/diagnostics.js";
import Screen from "../components/screen.jsx";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { profiles } from "../signals/contacts.js";
import { shortPubkey } from "../format.js";
import { listDesyncedChats, recreateChatConversation } from "../../domain/messaging/chat.js";
import { t } from "../signals/i18n.js";
import IconGlobe from "../icons/globe.jsx";
import IconServer from "../icons/server.jsx";
import IconShield from "../icons/shield.jsx";
import IconChevronDown from "../icons/chevron-down.jsx";

function envChecks() {
	return [
		[
			"Secure Context",
			window.isSecureContext,
			true,
			"Web Crypto и Service Worker требуют его (L-14). file:// не пройдёт.",
		],
		[
			"Web Crypto (crypto.subtle)",
			!!(window.crypto && window.crypto.subtle),
			true,
			"весь крипто-слой (NIP-44, MLS) стоит на нём",
		],
		[
			"IndexedDB",
			"indexedDB" in window,
			true,
			"единственное хранилище >100 МБ (Dexie)",
		],
		["WebSocket", "WebSocket" in window, true, "транспорт к relay"],
		[
			"Service Worker API",
			"serviceWorker" in navigator,
			true,
			"офлайн + версионированный cache",
		],
		[
			"MediaRecorder",
			"MediaRecorder" in window,
			false,
			"голосовые (не блокирует MVP)",
		],
	].map(([label, ok, critical, hint]) => ({ label, ok, critical, hint }));
}

function useServiceWorker() {
	const [state, set] = useState("инициализация…");
	useEffect(() => {
		if (!("serviceWorker" in navigator)) return set("не поддерживается");
		if (import.meta.env.DEV)
			return set("пропущено (dev — SW появляется только в vite build)");
		navigator.serviceWorker
			.register(import.meta.env.BASE_URL + "service-worker.js")
			.then((r) =>
				set(
					`зарегистрирован (${r.active ? "active" : r.installing ? "installing" : "waiting"})`,
				),
			)
			.catch((e) => set("ошибка: " + (e?.message || e)));
	}, []);
	return state;
}

function dbTone(state) {
	if (state.startsWith("открыта")) return "var(--good)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function useDatabaseStatus() {
	const [state, set] = useState("проверка…");
	useEffect(() => {
		db.open()
			.then(() => set(`открыта (${db.tables.length} таблиц)`))
			.catch((e) => set("ошибка: " + (e?.message || e)));
	}, []);
	return state;
}

function cacheTone(state) {
	if (state.startsWith("ugolok-cache-")) return "var(--good)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function useCacheStatus() {
	const [state, set] = useState("проверка…");
	useEffect(() => {
		if (!("caches" in window)) return set("не поддерживается");
		if (import.meta.env.DEV)
			return set("пропущено (dev — кэш появляется только в vite build)");
		let cancelled = false;
		(async () => {
			for (let i = 0; i < 20; i++) {
				const keys = await caches.keys();
				const match = keys.find((k) => k.startsWith("ugolok-cache-"));
				if (match) {
					const cache = await caches.open(match);
					const cachedKeys = await cache.keys();
					if (cancelled) return;
					if (cachedKeys.length > 0) {
						set(`${match}, ${cachedKeys.length} файлов в кэше`);
					} else {
						set(`ошибка: кэш ${match} создан, но пуст (precache не сработал)`);
					}
					return;
				}
				await new Promise((r) => setTimeout(r, 200));
			}
			if (!cancelled) set("ошибка: кэш не создан за отведённое время");
		})().catch((e) => !cancelled && set("ошибка: " + (e?.message || e)));
		return () => { cancelled = true; };
	}, []);
	return state;
}

function coreLogicTone(state) {
	if (state.startsWith("ok")) return "var(--good)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function useCoreLogicStatus() {
	const [state, set] = useState("проверка…");
	useEffect(() => {
		(async () => {
			try {
				const knownVector = {
					pubkey: "0".repeat(64),
					created_at: 1700000000,
					kind: 1,
					tags: [],
					content: "diagnostics-self-check",
					id: "33e86c5abb6f63c5ddb082aaf603171c2532d8e886710c491f02111c1f3697d3",
				};
				if (!validateEventId(knownVector)) {
					throw new Error("validateEventId: известный вектор не прошёл проверку");
				}
				if (validateEventId({ ...knownVector, content: "испорчено" })) {
					throw new Error("validateEventId: подмена содержимого не обнаружена");
				}

				const synthetic = {
					id: "diag-selfcheck-" + Date.now(),
					pubkey: "0".repeat(64),
					created_at: 1,
					kind: 1059,
					tags: [],
					content: "",
					sig: "s",
				};
				const r1 = await mergeEvent(synthetic);
				const r2 = await mergeEvent(synthetic);
				await db.table("events").where("id").equals(synthetic.id).delete();
				if (!r1.added || r2.added) {
					throw new Error("mergeEvent: нарушена идемпотентность");
				}

				const a = { id: "aaa", created_at: 500 };
				const b = { id: "bbb", created_at: 500 };
				if (lwwWinner(a, b) !== b) {
					throw new Error("lwwWinner: неверный тайбрейкер по id");
				}

				set("ok (validateEventId, mergeEvent, lwwWinner)");
			} catch (e) {
				set("ошибка: " + (e?.message || e));
			}
		})();
	}, []);
	return state;
}

function stage5Tone(state) {
	if (state.startsWith("ok")) return "var(--good)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function useOutboxStatus() {
	const [state, set] = useState("проверка…");
	useEffect(() => {
		(async () => {
			try {
				const diagEventId = "diag-selfcheck-" + Date.now();
				const diagDbKey = crypto.getRandomValues(new Uint8Array(32));
				const seq = await enqueue({ id: diagEventId, kind: 0, tags: [], content: "", sig: "", pubkey: "", created_at: 0 }, diagDbKey);
				const pendingBefore = await listPending(diagDbKey);
				if (!pendingBefore.some((r) => r.seq === seq)) {
					throw new Error("enqueue: запись не найдена в listPending");
				}
				await markSent(seq);
				const pendingAfter = await listPending(diagDbKey);
				if (pendingAfter.some((r) => r.seq === seq)) {
					throw new Error("markSent: запись всё ещё в listPending");
				}
				await db.table("outbox").delete(seq);
				set("ok (enqueue, listPending, markSent)");
			} catch (e) {
				set("ошибка: " + (e?.message || e));
			}
		})();
	}, []);
	return state;
}

function releaseHashTone(state) {
	if (state.startsWith("ошибка")) return "var(--bad)";
	if (state.startsWith("пропущено")) return "var(--muted)";
	return "var(--good)";
}

function useReleaseHashStatus() {
	const [state, set] = useState("проверка…");
	useEffect(() => {
		if (import.meta.env.DEV) {
			set("пропущено (dev — актуально только для собранного index.html)");
			return;
		}
		(async () => {
			try {
				const resp = await fetch(location.href, { cache: "no-store" });
				const buf = await resp.arrayBuffer();
				const digest = await crypto.subtle.digest("SHA-256", buf);
				const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
				set(hex);
			} catch (e) {
				set("ошибка: " + (e?.message || e));
			}
		})();
	}, []);
	return state;
}

function nip06Tone(state) {
	if (state.startsWith("ok")) return "var(--good)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function useNip06Status() {
	const [state, set] = useState("проверка…");
	useEffect(() => {
		(async () => {
			try {
				const VECTOR_MNEMONIC = "leader monkey parrot ring guide accident before fence cannon height naive bean";
				const VECTOR_PRIVKEY_HEX = "7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a";
				const VECTOR_PUBKEY_HEX = "17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917";
				const privKey = await mnemonicToPrivateKey(VECTOR_MNEMONIC);
				const privHex = bytesToHex(privKey);
				if (privHex !== VECTOR_PRIVKEY_HEX) {
					throw new Error("mnemonicToPrivateKey: смоук-вектор §16.1 не совпал (privKey)");
				}
				const pubKey = getPublicKey(privKey);
				const pubHex = bytesToHex(pubKey);
				if (pubHex !== VECTOR_PUBKEY_HEX) {
					throw new Error("getPublicKey: смоук-вектор §16.1 не совпал (pubKey)");
				}
				set("ok (NIP-06 §16.1 vector)");
			} catch (e) {
				set("ошибка: " + (e?.message || e));
			}
		})();
	}, []);
	return state;
}

function keystoreTone(state) {
	if (state.startsWith("ok")) return "var(--good)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function useKeystoreStatus() {
	const [state, set] = useState("проверка…");
	useEffect(() => {
		(async () => {
			try {
				const fakePrivKey = new Uint8Array(32).fill(9);
				const ms1 = deriveMasterSecret(fakePrivKey);
				const ms2 = deriveMasterSecret(fakePrivKey);
				if (bytesToHex(ms1) !== bytesToHex(ms2)) {
					throw new Error("deriveMasterSecret: не детерминирована");
				}
				const dbKeyDerived = deriveDbKey(ms1);
				if (dbKeyDerived.length !== 32) {
					throw new Error("deriveDbKey: неверная длина");
				}
				const tag1 = opaqueDTag(ms1, 30051, "a:b");
				const tag2 = opaqueDTag(ms1, 30051, "a:b");
				const tag3 = opaqueDTag(ms1, 30051, "a:c");
				if (tag1 !== tag2 || tag1 === tag3 || tag1.length !== 64) {
					throw new Error("opaqueDTag: не прошла проверку");
				}

				const testId = "diag-selfcheck-" + Date.now();
				await encryptAndStore(fakePrivKey, "diagnostics-self-check-password", testId);
				const decrypted = await decryptPrivateKey("diagnostics-self-check-password", testId);
				await db.table("keystore").delete(testId);
				if (bytesToHex(decrypted) !== bytesToHex(fakePrivKey)) {
					throw new Error("keystore round-trip не совпал");
				}

				set("ok (derivation + keystore round-trip)");
			} catch (e) {
				set("ошибка: " + (e?.message || e));
			}
		})();
	}, []);
	return state;
}

function nip9Tone(state) {
	if (state.startsWith("ok")) return "var(--good)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function useSignCryptoStatus() {
	const [state, set] = useState("проверка…");
	useEffect(() => {
		try {
			const aliceSk = generateSecretKey();
			const bobSk = generateSecretKey();
			const bobPk = nostrGetPublicKey(bobSk);
			const alicePk = nostrGetPublicKey(aliceSk);

			const signed = sign({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "diag" }, aliceSk);
			if (!verify(signed)) {
				throw new Error("sign/verify: валидное событие не прошло проверку");
			}
			const tampered = { ...signed, content: "tampered" };
			if (verify(tampered)) {
				throw new Error("verify: не обнаружил подмену (Symbol-кэш не защищён)");
			}

			const ct = nip44Encrypt("hello", aliceSk, bobPk);
			const pt = nip44Decrypt(ct, bobSk, alicePk);
			if (pt !== "hello") {
				throw new Error("nip44: round-trip не совпал");
			}

			const wrapped = nip59Wrap({ kind: 14, content: "hi", tags: [] }, aliceSk, bobPk);
			if (wrapped.kind !== 1059) {
				throw new Error("nip59: wrap не kind 1059");
			}
			const rumor = nip59Unwrap(wrapped, bobSk);
			if (rumor.content !== "hi" || rumor.pubkey !== alicePk) {
				throw new Error("nip59: unwrap не совпал");
			}

			set("ok (sign/verify, nip44, nip59)");
		} catch (e) {
			set("ошибка: " + (e?.message || e));
		}
	}, []);
	return state;
}

function cryptoWorkerTone(state) {
	if (state.startsWith("ok")) return "var(--good)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function transportSyncTone(state) {
	if (state.startsWith("ok")) return "var(--good)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function useCryptoWorkerStatus() {
	const [state, set] = useState("проверка…");
	useEffect(() => {
		let worker;
		(async () => {
			try {
				worker = new CryptoWorker();
				const api = Comlink.wrap(worker);
				const sk = generateSecretKey();
				const validEvent = sign({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "worker-check" }, sk);
				const invalidEvent = { ...validEvent, content: "tampered" };
				const results = await api.batchVerify([validEvent, invalidEvent]);
				if (!(results[0] === true && results[1] === false)) {
					throw new Error("batchVerify: неверный результат " + JSON.stringify(results));
				}

				const { encryptFile, decryptFile } = await import("../../core/crypto/file-crypto.js");
				const testFile = crypto.getRandomValues(new Uint8Array(1000));
				const { key, blob } = encryptFile(testFile);
				const decrypted = decryptFile(blob, key);
				const filesMatch = decrypted.length === testFile.length && decrypted.every((b, i) => b === testFile[i]);
				if (!filesMatch) {
					throw new Error("file-crypto: round-trip не совпал побайтно");
				}

				set("ok (batchVerify через Comlink Worker, file-crypto round-trip)");
			} catch (e) {
				set("ошибка: " + (e?.message || e));
			} finally {
				worker?.terminate();
			}
		})();
	}, []);
	return state;
}

// НЕ секрет: фиксированная тестовая identity ТОЛЬКО для этого self-check
// (sha256("ugolok-diagnostics-self-check-v1")). Раньше ключ генерировался
// заново на каждый клик — pubkey непредсказуем, поэтому write-whitelist
// локального relay (deny-by-default, этап 17, AC-14) отклонял публикацию
// каждый раз (см. log.md, этап 20). Один и тот же публично известный pubkey
// можно один раз внести в server/strfry/whitelist.json — остальные identity
// по-прежнему отклоняются, свойство whitelist не ослаблено.
const DIAGNOSTICS_SELF_CHECK_PRIVKEY = hexToBytes(
	"87d0ba41e92f084a0b82cdfac5a35cb8b0dd6ae279254eb71542f55c649ed32b",
);

function waitForConnState(conn, predicate, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (predicate(conn.getState())) return resolve();
		const t0 = Date.now();
		const iv = setInterval(() => {
			if (predicate(conn.getState())) {
				clearInterval(iv);
				resolve();
			} else if (Date.now() - t0 > timeoutMs) {
				clearInterval(iv);
				reject(new Error(`таймаут ожидания состояния соединения (сейчас: "${conn.getState()}")`));
			}
		}, 50);
	});
}

function useTransportSyncCheck() {
	const [status, setStatus] = useState("не запущен");
	const [connState, setConnState] = useState("disconnected");
	const [synced, setSynced] = useState(false);
	const relayUrl = DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777";

	async function run() {
		setStatus("подключение…");
		setSynced(false);
		let conn;
		let worker;
		try {
			const privKey = DIAGNOSTICS_SELF_CHECK_PRIVKEY;
			const pubKeyHex = bytesToHex(getPublicKey(privKey));

			conn = createRelayConnection(relayUrl, { onStateChange: (s) => setConnState(s) });
			conn.connect();
			await waitForConnState(conn, (s) => s === "connected", 8000);

			worker = new CryptoWorker();
			const api = Comlink.wrap(worker);
			const verifyBatch = (events) => api.batchVerify(events);

			setStatus("публикация профиля + relay-list…");
			const pub = createPublisher(conn);
			conn.addMessageHandler(pub.handleMessage);
			const profileEvent = buildProfileEvent(privKey, { name: "diag-self-check", about: "этап 20, самопроверка" });
			const relayListEvent = buildRelayListEvent(privKey, [{ url: relayUrl, read: true, write: true }]);
			const [profileResult, relayListResult] = await Promise.all([pub.publish(profileEvent), pub.publish(relayListEvent)]);
			if (!profileResult.ok || !relayListResult.ok) {
				throw new Error("relay отклонил публикацию (не в whitelist? см. server/strfry/whitelist.json)");
			}

			setStatus("bootstrap…");
			const bootResult = await runBootstrap(conn, pubKeyHex, { verifyBatch });
			if (bootResult.addedCount < 2) {
				throw new Error(`bootstrap нашёл ${bootResult.addedCount} из 2 ожидаемых событий`);
			}

			setStatus("инкрементальная синхронизация…");
			let caughtUp = false;
			const sync = await startIncrementalSync(conn, pubKeyHex, {
				verifyBatch,
				onCaughtUp: () => {
					caughtUp = true;
					setSynced(true);
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 500));
			sync.stop();
			if (!caughtUp) {
				throw new Error("incremental sync не подтвердил onCaughtUp");
			}

			setStatus(`ok (relay ${relayUrl}, bootstrap +${bootResult.addedCount}, sync подтверждён)`);
		} catch (e) {
			setStatus("ошибка: " + (e?.message || e));
		} finally {
			worker?.terminate();
			conn?.close();
		}
	}

	return { status, connState, synced, relayUrl, run };
}

// Этап 73.5 — М6 (детект расхождения): список переписок, у которых накопилось
// consecutiveDecryptFailures >= порога (chat.js, DESYNC_THRESHOLD) — устройство
// подряд, без единого успешного приёма, теряло kind:445 этой группы даже после
// повторных попыток буфера (73.4). "Пересоздать" — recreateChatConversation
// (chat.js): забывает локальное состояние, дальше отрабатывают уже
// существующие пути И3/И4 (коммиттер создаст заново / sibling-Welcome догонит).
function useDesyncedChats() {
	const [chats, setChats] = useState([]);
	const [busyContact, setBusyContact] = useState(null);

	async function refresh() {
		const user = currentUser.value;
		const dbKey = dbKeySig.value;
		if (!user || !dbKey) return setChats([]);
		setChats(await listDesyncedChats(user.id, dbKey));
	}

	useEffect(() => {
		refresh();
	}, [currentUser.value, dbKeySig.value]);

	async function recreate(contactPubkey) {
		const user = currentUser.value;
		const dbKey = dbKeySig.value;
		if (!user || !dbKey) return;
		setBusyContact(contactPubkey);
		try {
			await recreateChatConversation(user.id, contactPubkey, dbKey);
			await refresh();
		} finally {
			setBusyContact(null);
		}
	}

	return { chats, recreate, busyContact };
}

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
