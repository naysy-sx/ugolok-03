import "./styles/minimal.css";
import { render } from "preact";
import App from "./app.jsx";

let refreshing = false;
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (refreshing) return;
		refreshing = true;
		location.reload();
	});
}

const root = document.getElementById("app");
root.replaceChildren();
render(<App />, document.getElementById("app"));
