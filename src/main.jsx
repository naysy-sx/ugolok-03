import "./styles/minimal.css";
import { render } from "preact";
import { useState } from "preact/hooks";
import { NAV_ITEMS, DEFAULT_ACTIVE } from "./ui/nav-items.js";
import Diagnostics from "./ui/screens/diagnostics.jsx";
import Placeholder from "./ui/screens/placeholder.jsx";

let refreshing = false;
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (refreshing) return;
		refreshing = true;
		location.reload();
	});
}

function App() {
	const [activeId, setActiveId] = useState(DEFAULT_ACTIVE);

	return (
		<div style={{ display: "flex", minHeight: "100dvh" }}>
			<aside
				style={{
					flex: "0 0 auto",
					borderInlineEnd: "var(--border-width) solid var(--border)",
					padding: "var(--space-m)"
				}}
			>
				<nav role="navigation">
					<ul role="list">
						{NAV_ITEMS.map(item => (
							<li key={item.id}>
								<button
									type="button"
								 onClick={() => setActiveId(item.id)}
								 aria-current={item.id === activeId ? "page" : null}
								>
									{item.label}
								</button>
							</li>
						))}
					</ul>
				</nav>
			</aside>
			<div
				style={{
					flex: "1 1 auto",
					overflow: "auto"
				}}
			>
				{activeId === "diagnostics" ? <Diagnostics /> : <Placeholder title={NAV_ITEMS.find(item => item.id === activeId).label} />}
			</div>
		</div>
	);
}

const root = document.getElementById("app");
root.replaceChildren();
render(<App />, document.getElementById("app"));
