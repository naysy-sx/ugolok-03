// window.visualViewport, в отличие от layout viewport (window.innerHeight/
// 100dvh), корректно отражает область экрана, реально видимую поверх
// клавиатуры. Вызывается только для __TARGET__==="web" (main.jsx) — на
// Android/Capacitor тот же --keyboard-inset считает и инжектит нативный
// код (MainActivity.java), на остальных платформах переменная никогда не
// устанавливается и .shell's calc() (custom.css) вырождается в обычный
// 100dvh.
export function startKeyboardInsetTracking() {
	if (typeof window === "undefined" || !window.visualViewport) return () => {};
	const vv = window.visualViewport;
	function update() {
		const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
		document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`);
	}
	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", update);
	update();
	return () => {
		vv.removeEventListener("resize", update);
		vv.removeEventListener("scroll", update);
		document.documentElement.style.removeProperty("--keyboard-inset");
	};
}
