import "./styles/fonts.css";
import "./styles/minimal.css";
import "./styles/custom.css";
import { render } from "preact";
import App from "./app.jsx";
import { startIdleWatcher } from "./ui/signals/auth.js";

startIdleWatcher();

let refreshing = false;
if ("serviceWorker" in navigator) {
	// Если controller уже был на момент загрузки страницы — это обновление уже
	// работающего SW, перезагрузка нужна (подтянуть свежий код). Если controller
	// не было (самая первая регистрация ниже в этой же загрузке) — clients.claim()
	// тоже вызовет controllerchange, но обновлять нечего: reload() в этот момент
	// только сбросил бы сессию пользователя без причины.
	const hadControllerAtLoad = navigator.serviceWorker.controller !== null;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (refreshing || !hadControllerAtLoad) return;
		refreshing = true;
		location.reload();
	});

	// НАЙДЕНО ЖИВОЙ ПРОВЕРКОЙ (этап 53-довесок, тот же класс пробела, что
	// ensureConnected до этого): регистрация раньше жила ТОЛЬКО в
	// diagnostics.jsx's useServiceWorker (ленивая — только при первом заходе
	// на "Диагностика"). Плеер (И4, задача 4.1) перехватывает Range через SW —
	// без SW /files-content/* просто улетал бы в сеть и получал 404 у ЛЮБОГО
	// пользователя, ни разу не открывавшего Диагностику. Регистрация здесь —
	// сразу при загрузке приложения, безусловно. register() идемпотентен
	// (повторный вызов с тем же scriptURL из diagnostics.jsx резолвится в ТУ
	// ЖЕ регистрацию, не создаёт вторую) — оставлен как есть, ради статуса на
	// экране диагностики. В dev SW не эмитится вовсе (emitServiceWorker,
	// apply:"build") — регистрировать нечего.
	if (!import.meta.env.DEV) {
		navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`).catch(() => {});
	}
}

const root = document.getElementById("app");
root.replaceChildren();
render(<App />, document.getElementById("app"));
