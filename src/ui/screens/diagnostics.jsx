import { useState, useEffect } from "preact/hooks";
import { BUILD_HASH, BUILD_DEFAULT_RELAYS as DEFAULT_RELAYS } from "../../config.js";
import { db } from "../../core/store/database.js";
import { validateEventId } from "../../domain/events/validators.js";
import { mergeEvent } from "../../core/sync/g-set.js";
import { lwwWinner } from "../../core/sync/lww.js";
import { useRoute, ROUTES } from "../../ui/router.js";
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
import Dexie from "dexie";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { toEncryptedRow } from "../../core/store/encrypted-table.js";
import { generateSyntheticEvents } from "../../domain/events/synthetic-fixtures.js";
import { createRelayConnection } from "../../core/transport/relay-pool.js";
import { createPublisher } from "../../core/transport/publisher.js";
import { runBootstrap } from "../../core/sync/bootstrap.js";
import { startIncrementalSync } from "../../core/sync/incremental-sync.js";
import { buildProfileEvent } from "../../domain/identity/profile.js";
import { buildRelayListEvent } from "../../domain/identity/relay-list.js";
import SyncIndicator from "../components/sync-indicator.jsx";
import Screen from "../components/screen.jsx";

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
	if (state.startsWith("открыта")) return "var(--ok)";
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
	if (state.startsWith("ugolok-cache-")) return "var(--ok)";
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
	if (state.startsWith("ok")) return "var(--ok)";
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
	if (state.startsWith("ok")) return "var(--ok)";
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
	return "var(--ok)";
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
	if (state.startsWith("ok")) return "var(--ok)";
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
	if (state.startsWith("ok")) return "var(--ok)";
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
	if (state.startsWith("ok")) return "var(--ok)";
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
	if (state.startsWith("ok")) return "var(--ok)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function pSpikeTone(state) {
	if (state.startsWith("ok")) return "var(--ok)";
	if (state.startsWith("ошибка")) return "var(--bad)";
	return "var(--muted)";
}

function transportSyncTone(state) {
	if (state.startsWith("ok")) return "var(--ok)";
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

function usePSpikeBenchmark() {
	const [status, setStatus] = useState("не запущен");

	async function run() {
		setStatus("генерация синтетических событий (не входит в замер)…");
		// Отдать кадр браузеру ДО тяжёлой синхронной работы — иначе виден только
		// клик, статус выше физически не успевает отрисоваться до начала генерации.
		await new Promise((resolve) => setTimeout(resolve, 0));
		let worker;
		let benchDb;
		try {
			const { fixtures, giftwrapRecipientPrivKey } = await generateSyntheticEvents(5000);
			const ownerPubHex = bytesToHex(getPublicKey(giftwrapRecipientPrivKey));

			benchDb = new Dexie("ugolok-p-spike-bench-" + Date.now());
			benchDb.version(1).stores({ derived: "foldKey" });
			await benchDb.open();
			const dbKey = crypto.getRandomValues(new Uint8Array(32));

			worker = new CryptoWorker();
			const api = Comlink.wrap(worker);

			setStatus("прогон пайплайна (идёт замер)…");
			const t0 = performance.now();

			const verified = await api.batchVerify(fixtures.map((f) => f.event));

			// проход 1: fold-решение по МЕТАДАННЫМ (created_at/id) — без расшифровки,
			// расшифровывать имеет смысл только реального победителя LWW, не все версии
			const winnerByFoldKey = new Map();
			const fixtureByEventId = new Map();
			for (let i = 0; i < fixtures.length; i++) {
				if (!verified[i]) continue;
				const f = fixtures[i];
				if (f.kindGroup === "giftwrap") continue;
				fixtureByEventId.set(f.event.id, f);
				const existing = winnerByFoldKey.get(f.foldKey);
				winnerByFoldKey.set(f.foldKey, existing ? lwwWinner(existing, f.event) : f.event);
			}

			// проход 2: расшифровка + запись только победителей
			for (const [foldKey, winnerEvent] of winnerByFoldKey) {
				const f = fixtureByEventId.get(winnerEvent.id);
				let value;
				if (f.kindGroup === "profile") {
					value = JSON.parse(f.event.content);
				} else if (f.kindGroup === "permission-proxy") {
					value = JSON.parse(nip44Decrypt(f.event.content, giftwrapRecipientPrivKey, ownerPubHex));
				} else {
					const [nonceB64, ciphertextB64] = f.event.content.split(":");
					const nonce = Uint8Array.from(atob(nonceB64), (c) => c.charCodeAt(0));
					const ciphertext = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
					value = chacha20poly1305(f.channelKey, nonce).decrypt(ciphertext);
				}
				await benchDb.table("derived").put(toEncryptedRow({ foldKey, value }, ["foldKey"], dbKey));
			}

			// gift wrap'ы — журнал (G-Set), не fold: каждый расшифровывается и пишется как есть
			let journalCount = 0;
			for (let i = 0; i < fixtures.length; i++) {
				if (!verified[i] || fixtures[i].kindGroup !== "giftwrap") continue;
				nip59Unwrap(fixtures[i].event, giftwrapRecipientPrivKey);
				await mergeEvent(fixtures[i].event);
				journalCount++;
			}

			const elapsedMs = performance.now() - t0;
			const withinBudget = elapsedMs <= 30000;
			setStatus(
				(withinBudget ? "ok" : "ошибка") +
					` (${elapsedMs.toFixed(0)} мс на 5000 событий, журнал ${journalCount}, materialized ${winnerByFoldKey.size}; порог NF-09 30000 мс)`,
			);
		} catch (e) {
			setStatus("ошибка: " + (e?.message || e));
		} finally {
			worker?.terminate();
			if (benchDb) {
				benchDb.close();
				await benchDb.delete();
			}
		}
	}

	return { status, run };
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

function Row({ c }) {
	const tone = c.ok ? "var(--ok)" : c.critical ? "var(--bad)" : "var(--warn)";
	const mark = c.ok ? "✓" : c.critical ? "✗" : "!";
	return (
		<li
			class="row"
			style={{
				"--gap": "var(--space-s)",
				alignItems: "flex-start",
				paddingBlock: "var(--space-s)",
				borderBlockEnd: "var(--border-width) solid var(--border)",
			}}
		>
			<span
				aria-hidden="true"
				style={{ color: tone, fontWeight: "var(--weight-bold)" }}
			>
				{mark}
			</span>
			<span class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<span>{c.label}</span>
				{c.hint && <small style={{ color: "var(--muted)" }}>{c.hint}</small>}
			</span>
		</li>
	);
}

// Единая визуальная оболочка для всех проверок этапов (было: ~15 самостоятельно
// стилизованных <p>, каждая со своим inline-color — отсюда жалоба "пёстро и
// разрозненно"). tone/статус остаются per-check логикой (releaseHashTone,
// dbTone, ... — семантика "что считается ok" у них разная и намеренно не унифицирована),
// меняется только то, КАК это рисуется.
function StatusRow({ label, status, tone, action, hint }) {
	return (
		<li
			class="stack"
			style={{
				"--gap": "var(--space-3xs)",
				paddingBlock: "var(--space-s)",
				borderBlockEnd: "var(--border-width) solid var(--border)",
			}}
		>
			<span class="row" style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "space-between" }}>
				<span class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
					<span aria-hidden="true" style={{ color: tone }}>●</span>
					<span>{label}</span>
				</span>
				{action}
			</span>
			<small style={{ color: "var(--muted)", wordBreak: "break-all" }}>
				{status}
				{hint ? ` · ${hint}` : ""}
			</small>
		</li>
	);
}

function Section({ title, children }) {
	return (
		<section class="stack" style={{ "--gap": "var(--space-s)" }}>
			<h2
				style={{
					fontSize: "0.8rem",
					fontWeight: "var(--weight-bold)",
					textTransform: "uppercase",
					letterSpacing: "0.04em",
					color: "var(--muted)",
				}}
			>
				{title}
			</h2>
			<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
				{children}
			</ul>
		</section>
	);
}

export default function Diagnostics() {
	const checks = envChecks();
	const sw = useServiceWorker();
	const dbStatus = useDatabaseStatus();
	const cacheStatus = useCacheStatus();
	const coreLogicStatus = useCoreLogicStatus();

	const pass = checks.filter((c) => c.critical).every((c) => c.ok);

	const route = useRoute();
	const outboxStatus = useOutboxStatus();
	const releaseHashStatus = useReleaseHashStatus();
	const nip06Status = useNip06Status();
	const keystoreStatus = useKeystoreStatus();
	const signCryptoStatus = useSignCryptoStatus();
	const cryptoWorkerStatus = useCryptoWorkerStatus();
	const pSpike = usePSpikeBenchmark();
	const transportSync = useTransportSyncCheck();

	return (
		<Screen title="Проверка движка">
		<div
			class="stack"
			style={{
				"--gap": "var(--space-m)",
				"--ok": "oklch(0.62 0.17 150)",
				"--bad": "oklch(0.58 0.21 25)",
				"--warn": "oklch(0.72 0.15 85)",
			}}
		>
			<small style={{ color: "var(--muted)" }}>
				build <code>{BUILD_HASH}</code> · relays:{" "}
				{DEFAULT_RELAYS.length ? DEFAULT_RELAYS.join(", ") : "—"}
			</small>

			<p
				role="status"
				style={{
					paddingBlock: "var(--space-s)",
					paddingInline: "var(--space-m)",
					background: "var(--surface)",
					borderInlineStart: `3px solid ${pass ? "var(--ok)" : "var(--bad)"}`,
					color: pass ? "var(--ok)" : "var(--bad)",
				}}
			>
				{pass
					? "Критические API доступны — окружение пригодно"
					: "Нет критического API — клиент здесь не запустится"}
			</p>

			<Section title="Окружение">
				{checks.map((c) => (
					<Row c={c} />
				))}
				<StatusRow label="Маршрут" status={route} tone="var(--fg)" hint={`доступны: ${ROUTES.join(", ")}`} />
			</Section>

			<Section title="Ядро и криптография">
				<StatusRow label="Этап 4 · CRDT-примитивы" status={coreLogicStatus} tone={coreLogicTone(coreLogicStatus)} />
				<StatusRow label="Этап 7 · NIP-06" status={nip06Status} tone={nip06Tone(nip06Status)} />
				<StatusRow label="Этап 8 · KeyStore + деривация" status={keystoreStatus} tone={keystoreTone(keystoreStatus)} />
				<StatusRow label="Этап 9 · sign / NIP-44 / NIP-59" status={signCryptoStatus} tone={nip9Tone(signCryptoStatus)} />
				<StatusRow label="Этап 10 · файлы + crypto worker" status={cryptoWorkerStatus} tone={cryptoWorkerTone(cryptoWorkerStatus)} />
			</Section>

			<Section title="Хранилище и офлайн">
				<StatusRow label="База данных" status={dbStatus} tone={dbTone(dbStatus)} />
				<StatusRow label="Этап 5 · роутер + outbox" status={outboxStatus} tone={stage5Tone(outboxStatus)} />
				<StatusRow label="Service Worker" status={sw} tone="var(--fg)" />
				<StatusRow label="Кэш (Service Worker)" status={cacheStatus} tone={cacheTone(cacheStatus)} />
				<StatusRow label="Этап 6 · release-хеш" status={releaseHashStatus} tone={releaseHashTone(releaseHashStatus)} />
			</Section>

			<Section title="Транспорт и синхронизация">
				<StatusRow
					label="Этап 15 · P-SPIKE (5000 событий)"
					status={pSpike.status}
					tone={pSpikeTone(pSpike.status)}
					action={
						<button type="button" onClick={pSpike.run}>
							Запустить
						</button>
					}
				/>
				<StatusRow
					label="Этапы 16-20 · relay pool + AUTH + publisher/subscriber + bootstrap + sync"
					status={transportSync.status}
					tone={transportSyncTone(transportSync.status)}
					action={
						<button type="button" onClick={transportSync.run}>
							Проверить
						</button>
					}
				/>
				<li class="row" style={{ "--gap": "var(--space-s)", alignItems: "center", paddingBlock: "var(--space-s)" }}>
					Соединение:{" "}
					<SyncIndicator state={transportSync.connState} synced={transportSync.synced} url={transportSync.relayUrl} />
				</li>
			</Section>

			<small style={{ color: "var(--muted)", wordBreak: "break-all" }}>
				{navigator.userAgent}
			</small>
		</div>
		</Screen>
	);
}
