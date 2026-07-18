import "./styles/minimal.css";
import { render } from "preact";
import App from "./app.jsx";
import { startIdleWatcher } from "./ui/signals/auth.js";

startIdleWatcher();

let refreshing = false;
if ("serviceWorker" in navigator) {
	// Если controller уже был на момент загрузки страницы — это обновление уже
	// работающего SW, перезагрузка нужна (подтянуть свежий код). Если controller
	// не было (первая регистрация в этой вкладке — регистрация в diagnostics.jsx
	// ленивая, срабатывает только при первом заходе на "Диагностика") —
	// clients.claim() тоже вызовет controllerchange, но обновлять нечего:
	// reload() в этот момент только сбросил бы сессию пользователя без причины.
	const hadControllerAtLoad = navigator.serviceWorker.controller !== null;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (refreshing || !hadControllerAtLoad) return;
		refreshing = true;
		location.reload();
	});
}

const root = document.getElementById("app");
root.replaceChildren();
render(<App />, document.getElementById("app"));
