// __BUILD_HASH__ заменяется в сборке плагином emitServiceWorker (vite.config.js, DoD 1.2).
// В dev (vite.config.js's devServiceWorkerPlugin) подставляется буквальная строка
// "dev" — сигнал IS_DEV ниже: сборка не singlefile (много отдельных модулей),
// precache/cache-first статики здесь бессмысленны и ЛОМАЮТ HMR (кэш отдавал бы
// старый код после правки файла). files-content:range-* — единственное, что
// нужно активным в dev (Этап E, живая проверка пользователя: mp3/mp4 не играли
// в dev именно потому, что SW там не регистрировался вовсе).
const BUILD_HASH = "__BUILD_HASH__";
const IS_DEV = BUILD_HASH === "dev";
const CACHE = `ugolok-cache-v${BUILD_HASH}`; // F-OF-06
const PRECACHE = ["./", "./index.html"]; // singlefile → весь клиент в одном файле

self.addEventListener("install", (e) => {
	self.skipWaiting(); // F-OF-05
	if (IS_DEV) return;
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

// === Плеер файлов: перехват Range (этап 53 И4, задача 4.1) ===
// Этот файл НЕ проходит сборку Vite (emitServiceWorker просто копирует текст
// с подстановкой __BUILD_HASH__) — import из node_modules/src здесь не
// резолвится, поэтому крипто/сеть к Blossom НЕ делаются тут самим SW.
// CONTRACTS.md/DESIGN.md, этап 53 И4: SW — тонкий протокольный адаптер,
// расшифрованные байты запрашиваются у СТРАНИЦЫ (той самой вкладки,
// event.clientId — не broadcast, разные вкладки могут иметь разные
// разблокированные аккаунты) через postMessage, ключи/сеть остаются на ней.
const FILES_CONTENT_PREFIX = "/files-content/";
const FILES_CONTENT_TIMEOUT_MS = 15000;
const pendingRangeRequests = new Map(); // requestId -> {resolve, reject}

self.addEventListener("message", (e) => {
	const msg = e.data;
	if (!msg || msg.type !== "files-content:range-response") return;
	const pending = pendingRangeRequests.get(msg.requestId);
	if (!pending) return; // ответ на уже протухший (таймаут) или чужой запрос — игнор
	pendingRangeRequests.delete(msg.requestId);
	pending.resolve(msg);
});

// requestId — корреляция КОНКУРЕНТНЫХ запросов одного видео (буферизация +
// перемотка одновременно, DESIGN.md "гонка 1"): каждый Range-fetch — свой
// requestId, свой ожидающий Promise, ответы не должны перепутаться местами.
function requestRangeFromClient(client, manifestDigest, start, end) {
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingRangeRequests.delete(requestId);
			reject(new Error("files-content: таймаут ожидания ответа вкладки"));
		}, FILES_CONTENT_TIMEOUT_MS);
		pendingRangeRequests.set(requestId, {
			resolve: (msg) => {
				clearTimeout(timer);
				resolve(msg);
			},
		});
		client.postMessage({ type: "files-content:range-request", requestId, manifestDigest, start, end });
	});
}

const FILES_CONTENT_ERROR_STATUS = {
	"unknown-digest": 404,
	"range-out-of-bounds": 416,
	"decrypt-failed": 500,
};

async function handleFilesContentFetch(e) {
	const url = new URL(e.request.url);
	const manifestDigest = url.pathname.slice(FILES_CONTENT_PREFIX.length);

	// Range header отсутствует у некоторых самых первых запросов <video>/<audio>
	// (до того, как браузер узнал про Accept-Ranges) — нормализуем в "с начала,
	// граница открыта", а не отдаём файл целиком: страница сама разрешит
	// открытый диапазон в manifest.size-1 (player-bridge.js), тот же путь, что
	// честный "bytes=X-" без верхней границы.
	let start = 0;
	let end = null;
	const rangeHeader = e.request.headers.get("Range");
	if (rangeHeader) {
		const m = /bytes=(\d+)-(\d+)?/.exec(rangeHeader);
		if (m) {
			start = Number(m[1]);
			end = m[2] !== undefined && m[2] !== "" ? Number(m[2]) : null;
		}
	}

	const client = await self.clients.get(e.clientId);
	if (!client) {
		return new Response("files-content: нет активной вкладки для этого запроса", { status: 404 });
	}

	let res;
	try {
		res = await requestRangeFromClient(client, manifestDigest, start, end);
	} catch {
		return new Response("files-content: таймаут", { status: 504 });
	}

	if (!res.ok) {
		return new Response(res.error || "files-content: ошибка", { status: FILES_CONTENT_ERROR_STATUS[res.error] || 500 });
	}

	// resolvedEnd — из ФАКТИЧЕСКИ вернувшихся байт, не из запрошенного end
	// (который мог быть открытым, null) — корректно в обоих случаях.
	const resolvedEnd = start + res.bytes.length - 1;
	return new Response(res.bytes, {
		status: 206,
		headers: {
			"Content-Type": res.mime || "application/octet-stream",
			"Content-Range": `bytes ${start}-${resolvedEnd}/${res.size}`,
			"Content-Length": String(res.bytes.length),
			"Accept-Ranges": "bytes",
		},
	});
}

self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET") return; // F-OF-04: динамика — network-only
	const url = new URL(req.url);

	if (url.pathname.startsWith(FILES_CONTENT_PREFIX)) {
		e.respondWith(handleFilesContentFetch(e));
		return;
	}

	// SW не кеширует сам себя — иначе застрянет на старой версии.
	if (url.pathname.endsWith("service-worker.js")) return;
	// Кросс-origin (Blossom HTTP, relay) — не трогаем, уходит в сеть. WS через fetch вообще не идёт.
	if (url.origin !== self.location.origin) return;
	// dev: не трогать статику вовсе (см. комментарий у BUILD_HASH/IS_DEV) —
	// только files-content:range-* выше, обычный fetch для всего остального.
	if (IS_DEV) return;

	// Статика того же origin — cache-first, офлайн-фолбэк на index.html (A-01).
	e.respondWith(
		caches
			.match(req)
			.then(
				(hit) => hit || fetch(req).catch(() => caches.match("./index.html")),
			),
	);
});
