import { useState, useEffect } from "preact/hooks";
import { BUILD_HASH, BUILD_DEFAULT_RELAYS as DEFAULT_RELAYS } from "../../config.js";
import { db } from "../../core/store/database.js";
import { validateEventId } from "../../domain/events/validators.js";
import { mergeEvent } from "../../core/sync/g-set.js";
import { lwwWinner } from "../../core/sync/lww.js";
import { useRoute, ROUTES } from "../../ui/router.js";
import { enqueue, listPending, markSent } from "../../core/store/outbox.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { mnemonicToPrivateKey } from "../../core/crypto/mnemonic.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { deriveMasterSecret, deriveDbKey, opaqueDTag } from "../../core/crypto/derivation.js";
import { encryptAndStore, decryptPrivateKey } from "../../core/crypto/keystore.js";

let refreshing = false;
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (refreshing) return;
		refreshing = true;
		location.reload();
	});
}

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
				const seq = await enqueue("diag-selfcheck-" + Date.now());
				const pendingBefore = await listPending();
				if (!pendingBefore.some((r) => r.seq === seq)) {
					throw new Error("enqueue: запись не найдена в listPending");
				}
				await markSent(seq);
				const pendingAfter = await listPending();
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
				const existing = await db.table("keystore").get("privkey");
				if (existing) {
					set("пропущено (уже есть сохранённый ключ — не трогаем боевые данные)");
					return;
				}

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

				await encryptAndStore(fakePrivKey, "diagnostics-self-check-password");
				const decrypted = await decryptPrivateKey("diagnostics-self-check-password");
				await db.table("keystore").delete("privkey");
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

function Row({ c }) {
	const tone = c.ok ? "var(--ok)" : c.critical ? "var(--bad)" : "var(--warn)";
	const mark = c.ok ? "✓" : c.critical ? "✗" : "!";
	return (
		<li
			class="cluster"
			style={{
				"--cluster-gap": "var(--space-s)",
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
			<span class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<span>{c.label}</span>
				{c.hint && <small style={{ color: "var(--muted)" }}>{c.hint}</small>}
			</span>
		</li>
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

	return (
		<main
			class="center flow"
			style={{
				"--container": "44rem",
				"--ok": "oklch(0.62 0.17 150)",
				"--bad": "oklch(0.58 0.21 25)",
				"--warn": "oklch(0.72 0.15 85)",
				paddingBlock: "var(--space-xl)",
				paddingInline: "var(--space-m)",
			}}
		>
			<header class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<p class="eyebrow">Уголок · диагностика окружения</p>
				<h1>Проверка движка</h1>
				<small style={{ color: "var(--muted)" }}>
					build <code>{BUILD_HASH}</code> · relays:{" "}
					{DEFAULT_RELAYS.length ? DEFAULT_RELAYS.join(", ") : "—"}
				</small>
			</header>

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

			<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
				{checks.map((c) => (
					<Row c={c} />
			 ))}
			</ul>

			<p style={{ color: "var(--muted)" }}>
				Маршрут: <strong style={{ color: "var(--fg)" }}>{route}</strong> (доступны: {ROUTES.join(", ")})
			</p>
			<p style={{ color: "var(--muted)" }}>
				Этап 5 (роутер + outbox): <strong style={{ color: stage5Tone(outboxStatus) }}>{outboxStatus}</strong>
			</p>

			<p style={{ color: "var(--muted)" }}>
				Этап 6 (release-хеш): <strong style={{ color: releaseHashTone(releaseHashStatus), wordBreak: "break-all" }}>{releaseHashStatus}</strong>
			</p>

			<p style={{ color: "var(--muted)" }}>
				Этап 7 (NIP-06): <strong style={{ color: nip06Tone(nip06Status) }}>{nip06Status}</strong>
			</p>

			<p style={{ color: "var(--muted)" }}>
				Этап 8 (KeyStore + деривация): <strong style={{ color: keystoreTone(keystoreStatus) }}>{keystoreStatus}</strong>
			</p>

			<p style={{ color: "var(--muted)" }}>
				Service Worker: <strong style={{ color: "var(--fg)" }}>{sw}</strong>
			</p>

			<p style={{ color: "var(--muted)" }}>
				Кэш (Service Worker): <strong style={{ color: cacheTone(cacheStatus) }}>{cacheStatus}</strong>
			</p>

			<p style={{ color: "var(--muted)" }}>
				База данных: <strong style={{ color: dbTone(dbStatus) }}>{dbStatus}</strong>
			</p>

			<p style={{ color: "var(--muted)" }}>
				Этап 4 (CRDT-примитивы): <strong style={{ color: coreLogicTone(coreLogicStatus) }}>{coreLogicStatus}</strong>
			</p>

			<small style={{ color: "var(--muted)", wordBreak: "break-all" }}>
				{navigator.userAgent}
			</small>
		</main>
	);
}
