import { useState, useEffect } from "preact/hooks";

const BUILD_HASH =
	typeof __BUILD_HASH__ !== "undefined" ? __BUILD_HASH__ : "unknown";
const DEFAULT_RELAYS =
	typeof __BUILD_DEFAULT_RELAYS__ !== "undefined"
		? __BUILD_DEFAULT_RELAYS__
		: [];

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
	const pass = checks.filter((c) => c.critical).every((c) => c.ok);

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
				Service Worker: <strong style={{ color: "var(--fg)" }}>{sw}</strong>
			</p>
			<small style={{ color: "var(--muted)", wordBreak: "break-all" }}>
				{navigator.userAgent}
			</small>
		</main>
	);
}
