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

// TZ-diag-trace.md §7 — этот файл не проходит сборку Vite (см. комментарий
// выше), импортировать src/core/diag/call-trace.js сюда нельзя технически, не
// только по правилу DI. Вместо этого — best-effort broadcast двух редких
// (раз в деплой) фактов страницам; страница сама решает, писать их в
// трассировку или нет (isTraceEnabled() там же). НЕ меняет ни skipWaiting(),
// ни clients.claim(), ни порядок caches-операций ниже ни на строку (TZ §0.1) —
// только добавляет уведомление рядом.
function notifyClients(type) {
	self.clients
		.matchAll()
		.then((clients) => clients.forEach((c) => c.postMessage({ type })))
		.catch(() => {});
}

self.addEventListener("install", (e) => {
	self.skipWaiting(); // F-OF-05
	notifyClients("sw-trace:install");
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
			notifyClients("sw-trace:activate");
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
// Держит паритет с src/domain/files/sw-timeout.js (тот же экспорт зеркалит
// player-bridge.js) — этот файл не проходит сборку Vite (emitServiceWorker
// копирует текст как есть), импорт из src сюда не резолвится, значения
// дублируются вручную. Править ВСЕ ТРИ места разом (FILES-FIX-SPEC.md §6.1,
// TZ-FIX-FILES-MEDIA-STATIC.md 5.5, MEDIA-PERF-TZ.md §5.3).
const PLAYER_FIRST_WINDOW_BYTES = 512 * 1024;
// MEDIA-PERF-TZ.md §5.3 — потолок адаптивного окна (растёт при последовательном
// чтении, сбрасывается при разрыве/перемотке): 512К -> 1М -> 2М -> 4М.
const PLAYER_MAX_WINDOW_BYTES = 4 * 1024 * 1024;
// Фиксированные 15 с были неверной единицей: маленький диапазон должен
// падать быстро, большой (открытое окно) имеет право ждать дольше при
// медленном TTFB. Бюджет = пол 15 с + 1 с на каждые 32 КиБ ожидаемых байт.
// Потолок был 60 с — хватало на 512 КБ (~31с по формуле), но НЕ хватает на
// выросшее до 4 МиБ окно (~143с по формуле) на медленной сети (эта
// аудитория) — ложный обрыв (504) именно там, где окно и должно было помочь.
// 150 с покрывает 4 МиБ с запасом, для старых маленьких окон не меняет
// поведение (формула и так даёт значение сильно меньше обоих потолков).
// Дублируется в src/domain/files/sw-timeout.js для юнит-теста чистых
// функций — держать формулы синхронными в обоих местах.
const FILES_CONTENT_TIMEOUT_FLOOR_MS = 15000;
const FILES_CONTENT_TIMEOUT_CEIL_MS = 150000;
function resolveFilesContentTimeoutMs(expectedBytes) {
	const ms = FILES_CONTENT_TIMEOUT_FLOOR_MS + (expectedBytes / 32768) * 1000;
	return Math.min(FILES_CONTENT_TIMEOUT_CEIL_MS, Math.max(FILES_CONTENT_TIMEOUT_FLOOR_MS, ms));
}

// MEDIA-PERF-TZ.md §5.3 / MEDIA-PERF-TZ-4.md §6 — windowState:
// manifestDigest -> {lastEnd, windowBytes, bytesPerSec}. sequential — start
// ровно там, где закончился предыдущий ОТВЕТ по этому же digest. Иначе
// (первый запрос ИЛИ перемотка/разрыв) -> сброс в PLAYER_FIRST_WINDOW_BYTES.
// Если скорость канала уже измерена (bytesPerSec) — окно целится в
// WINDOW_TARGET_SECONDS секунд передачи по этой скорости (не просто
// удваивается вслепую); удвоение остаётся потолком ОДНОГО шага в любом
// случае. Тот же код, что nextAdaptiveWindow в src/domain/files/sw-timeout.js
// — синхронно править оба места.
const windowState = new Map();
function nextAdaptiveWindow(state, start) {
	const sequential = !!state && start === state.lastEnd + 1;
	if (!sequential) return { windowBytes: PLAYER_FIRST_WINDOW_BYTES, sequential: false };

	const doubled = Math.min(state.windowBytes * 2, PLAYER_MAX_WINDOW_BYTES);
	if (!state.bytesPerSec) return { windowBytes: doubled, sequential: true };

	const targetBytes = state.bytesPerSec * WINDOW_TARGET_SECONDS;
	const windowBytes = Math.min(Math.max(Math.min(targetBytes, doubled), PLAYER_FIRST_WINDOW_BYTES), PLAYER_MAX_WINDOW_BYTES);
	return { windowBytes, sequential: true };
}
const WINDOW_TARGET_SECONDS = 3;
const SPEED_SMOOTHING_ALPHA = 0.3;
function updateObservedSpeed(prevBytesPerSec, bytesTransferred, elapsedMs) {
	if (!(elapsedMs > 0)) return prevBytesPerSec ?? 0;
	const sample = (bytesTransferred / elapsedMs) * 1000;
	if (prevBytesPerSec == null) return sample;
	return SPEED_SMOOTHING_ALPHA * sample + (1 - SPEED_SMOOTHING_ALPHA) * prevBytesPerSec;
}

// MEDIA-PERF-TZ-4.md §5 — детектор простоя. Потолок таймаута (150с) честно
// нужен для медленной, но ЖИВОЙ передачи; побочный эффект — на мёртвом
// Blossom плеер "грузится" почти 2.5 минуты, ровно то ощущение зависания,
// ради которого затевалась вся работа. Второй, НЕЗАВИСИМЫЙ таймер сбрасывается
// на каждый фактически пришедший чанк (progress()) и стреляет через
// STALL_TIMEOUT_MS молчания — не дожидаясь общего потолка. Тот же код, что
// createStallGuard в src/domain/files/sw-timeout.js — синхронно править оба
// места; parity-тест (tests/files-sw-parity.test.js) сверяет константу.
const STALL_TIMEOUT_MS = 12000;
function createStallGuard(ceilingMs, stallMs, onTimeout) {
	let settled = false;
	// До первого чанка застойный таймер не тикает — иначе мобильный TTFB
	// (getManifest + первый GET на Blossom) регулярно > 12с и плеер получает
	// 504 ещё до старта. «Тишина с самого начала» ловит потолок.
	let stallTimer = null;
	let ceilingTimer = setTimeout(() => fire("ceiling"), ceilingMs);
	function fire(reason) {
		if (settled) return;
		settled = true;
		clearTimeout(stallTimer);
		clearTimeout(ceilingTimer);
		onTimeout(reason);
	}
	return {
		progress() {
			if (settled) return;
			clearTimeout(stallTimer);
			stallTimer = setTimeout(() => fire("stall"), stallMs);
		},
		settle() {
			if (settled) return;
			settled = true;
			clearTimeout(stallTimer);
			clearTimeout(ceilingTimer);
		},
	};
}

const pendingRangeRequests = new Map(); // requestId -> {resolve, reject, guard}

self.addEventListener("message", (e) => {
	const msg = e.data;
	if (!msg) return;
	if (msg.type === "files-content:range-response") {
		const pending = pendingRangeRequests.get(msg.requestId);
		if (!pending) return; // ответ на уже протухший (таймаут) или чужой запрос — игнор
		pendingRangeRequests.delete(msg.requestId);
		pending.guard.settle();
		pending.resolve(msg);
		return;
	}
	// MEDIA-PERF-TZ-4.md §5 — промежуточный пинг "чанк пришёл", раньше
	// финального range-response: сбрасывает ТОЛЬКО застойный таймер, не потолок.
	if (msg.type === "files-content:range-progress") {
		const pending = pendingRangeRequests.get(msg.requestId);
		pending?.guard.progress();
	}
});

// requestId — корреляция КОНКУРЕНТНЫХ запросов одного видео (буферизация +
// перемотка одновременно, DESIGN.md "гонка 1"): каждый Range-fetch — свой
// requestId, свой ожидающий Promise, ответы не должны перепутаться местами.
function requestRangeFromClient(client, manifestDigest, start, end, expectedBytes) {
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const guard = createStallGuard(resolveFilesContentTimeoutMs(expectedBytes), STALL_TIMEOUT_MS, (reason) => {
			pendingRangeRequests.delete(requestId);
			reject(new Error(`files-content: ${reason === "stall" ? "простой" : "таймаут"} ожидания ответа вкладки`));
		});
		pendingRangeRequests.set(requestId, {
			resolve,
			guard,
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

	// iOS/WebKit: fetch от <video>/<audio> часто приходит с пустым clientId,
	// хотя вкладка контролируется — clients.get("") даёт null и плеер видел
	// 404 на каждый Range. Фолбэк: первая контролируемая window-вкладка.
	let client = e.clientId ? await self.clients.get(e.clientId) : null;
	if (!client) {
		const windows = await self.clients.matchAll({ type: "window" });
		client = windows[0] || null;
	}
	if (!client) {
		return new Response("files-content: нет активной вкладки для этого запроса", { status: 404 });
	}

	// MEDIA-PERF-TZ.md §5.3 — открытый диапазон (end===null): МЫ решаем окно
	// здесь (SW видит все запросы по этому digest первым, до player-bridge.js),
	// растя его при последовательном чтении (§6 — по фактической скорости, не
	// вслепую). Отдаём странице УЖЕ КОНКРЕТНЫЙ end — её собственный фолбэк на
	// PLAYER_FIRST_WINDOW_BYTES (player-bridge.js) остаётся только для прямых
	// вызовов в обход SW (тесты). Явный end от браузера уважаем как есть
	// (решение №6 TZ-FIX-FILES-MEDIA-STATIC.md) — редкий путь, но windowState
	// всё равно обновляем ниже, чтобы следующий ОТКРЫТЫЙ запрос по этому digest
	// продолжал расти от разумной базы.
	const prevWindow = windowState.get(manifestDigest);
	const { windowBytes } = nextAdaptiveWindow(prevWindow, start);
	const resolvedRequestEnd = end !== null ? end : start + windowBytes - 1;
	const expectedBytes = resolvedRequestEnd - start + 1;

	const requestStartedAt = Date.now();
	let res;
	try {
		res = await requestRangeFromClient(client, manifestDigest, start, resolvedRequestEnd, expectedBytes);
	} catch {
		windowState.delete(manifestDigest); // таймаут/простой — не наследовать раздутое окно следующему запросу
		return new Response("files-content: таймаут", { status: 504 });
	}

	if (!res.ok) {
		windowState.delete(manifestDigest);
		return new Response(res.error || "files-content: ошибка", { status: FILES_CONTENT_ERROR_STATUS[res.error] || 500 });
	}

	// resolvedEnd — из ФАКТИЧЕСКИ вернувшихся байт, не из запрошенного end
	// (может быть короче у конца файла) — корректно в обоих случаях.
	const resolvedEnd = start + res.bytes.length - 1;
	const elapsedMs = Date.now() - requestStartedAt;
	const bytesPerSec = updateObservedSpeed(prevWindow?.bytesPerSec, res.bytes.length, elapsedMs);
	windowState.set(manifestDigest, { lastEnd: resolvedEnd, windowBytes: Math.max(PLAYER_FIRST_WINDOW_BYTES, res.bytes.length), bytesPerSec });
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
