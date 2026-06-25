// __BUILD_HASH__ заменяется в сборке плагином emitServiceWorker (vite.config.js, DoD 1.2).
const BUILD_HASH = "__BUILD_HASH__";
const CACHE = `ugolok-cache-v${BUILD_HASH}`; // F-OF-06
const PRECACHE = ["./", "./index.html"]; // singlefile → весь клиент в одном файле

self.addEventListener("install", (e) => {
	self.skipWaiting(); // F-OF-05
	e.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(PRECACHE))
			.catch(() => {}),
	);
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter((k) => k.startsWith("ugolok-cache-") && k !== CACHE)
					.map((k) => caches.delete(k)),
			); // F-OF-06: чистим старые версии
			await self.clients.claim(); // F-OF-05
		})(),
	);
});

self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET") return; // F-OF-04: динамика — network-only
	const url = new URL(req.url);

	// SW не кеширует сам себя — иначе застрянет на старой версии.
	if (url.pathname.endsWith("service-worker.js")) return;
	// Кросс-origin (Blossom HTTP, relay) — не трогаем, уходит в сеть. WS через fetch вообще не идёт.
	if (url.origin !== self.location.origin) return;

	// Статика того же origin — cache-first, офлайн-фолбэк на index.html (A-01).
	e.respondWith(
		caches
			.match(req)
			.then(
				(hit) => hit || fetch(req).catch(() => caches.match("./index.html")),
			),
	);
});
