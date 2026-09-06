import "./styles/fonts.css";
import "./styles/minimal.css";
import "./styles/prosemirror.css";
import "./styles/custom.css";
import { render } from "preact";
import App from "./app.jsx";
import { startIdleWatcher } from "./ui/signals/auth.js";
import { BUILD_HASH } from "./config.js";
import { logInfo } from "./core/diag/boot-log.js";

logInfo(`запуск, сборка ${BUILD_HASH}`);

startIdleWatcher();

const SW_RELOAD_ONCE_KEY = "ugolok.swReloadOnce";
let refreshing = false;
// Живая проверка (прод, 2026-09-06) — только что загруженный видео-файл
// открывался, но не играл: /files-content/<хэш> (плеер, И4) уходил мимо SW
// прямо в сеть и получал SPA-фолбэк index.html вместо расшифрованных байт
// (Caddy try_files отдаёт его на любой неизвестный путь) — <video> получает
// HTML вместо видео. Причина — navigator.serviceWorker.controller оставался
// null сколько угодно долго ПОСЛЕ activate+clients.claim() (проверено —
// не гонка на миллисекунды, а стабильно null у уже загруженной страницы,
// пока её не перезагрузили вручную). Условие "hadControllerAtLoad" ниже
// как раз и исключало reload ИМЕННО в этом случае (самая первая регистрация,
// controller ещё не было) — считая, что "обновлять нечего", хотя обновить
// нужно было саму способность SW перехватывать запросы этой вкладки.
function reloadForFreshServiceWorker() {
	if (refreshing) return;
	let alreadyTried = false;
	try {
		alreadyTried = sessionStorage.getItem(SW_RELOAD_ONCE_KEY) === "1";
	} catch {
		// приватный режим/квота — считаем, что не пробовали, максимум лишний reload
	}
	if (alreadyTried) return; // не зацикливаться, если controller так и не появится
	try {
		sessionStorage.setItem(SW_RELOAD_ONCE_KEY, "1");
	} catch {
		// не критично — хуже случай: один лишний reload
	}
	refreshing = true;
	location.reload();
}

if ("serviceWorker" in navigator) {
	navigator.serviceWorker.addEventListener("controllerchange", reloadForFreshServiceWorker);

	// НАЙДЕНО ЖИВОЙ ПРОВЕРКОЙ (этап 53-довесок, тот же класс пробела, что
	// ensureConnected до этого): регистрация раньше жила ТОЛЬКО в
	// diagnostics.jsx's useServiceWorker (ленивая — только при первом заходе
	// на "Диагностика"). Плеер (И4, задача 4.1) перехватывает Range через SW —
	// без SW /files-content/* просто улетал бы в сеть и получал 404 у ЛЮБОГО
	// пользователя, ни разу не открывавшего Диагностику. Регистрация здесь —
	// сразу при загрузке приложения, безусловно. register() идемпотентен
	// (повторный вызов с тем же scriptURL из diagnostics.jsx резолвится в ТУ
	// ЖЕ регистрацию, не создаёт вторую) — оставлен как есть, ради статуса на
	// экране диагностики.
	// Этап E, найдено живой проверкой пользователя — раньше здесь стояло
	// `if (!import.meta.env.DEV)`, потому что emitServiceWorker (vite.config.js)
	// работает только на build, и в dev регистрировать было нечего (404).
	// vite.config.js's devServiceWorkerPlugin теперь раздаёт service-worker.js
	// и в dev (с IS_DEV-веткой внутри самого SW — precache/cache-first статики
	// выключены, чтобы не сломать HMR), поэтому регистрация безусловна.
	navigator.serviceWorker
		.register(`${import.meta.env.BASE_URL}service-worker.js`)
		.then(async () => {
			logInfo("service worker зарегистрирован");
			// controllerchange мог не успеть сработать до этой проверки (или не
			// сработать вовсе, если clients.claim() уже отработал до подписки на
			// событие) — прямой чек после готовности как подстраховка.
			await navigator.serviceWorker.ready;
			if (!navigator.serviceWorker.controller) reloadForFreshServiceWorker();
		})
		.catch(() => {});
}

const root = document.getElementById("app");
root.replaceChildren();
render(<App />, document.getElementById("app"));
