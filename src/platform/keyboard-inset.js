// Э4.7 ТЗ-NATIVE-APPS — найдено живьём (эмулятор, Android 16/API 36):
// WebView не меняет размер при появлении клавиатуры даже с явным
// android:windowSoftInputMode="adjustResize" в манифесте — известный
// нерешённый апстрим-баг Capacitor 8 в edge-to-edge на Android 15/16
// (ionic-team/capacitor#7983, #8432, "WebView is not resizing when the
// keyboard is visible"). window.visualViewport, в отличие от layout viewport
// (window.innerHeight/100dvh), КОРРЕКТНО отражает область экрана, реально
// видимую поверх клавиатуры в Chromium — используем его напрямую вместо
// того, чтобы ждать апстрим-фикс. Только вызывается для __TARGET__==="capacitor"
// (main.jsx) — на остальных платформах --keyboard-inset никогда не
// устанавливается, .shell's calc() (custom.css) вырождается в обычный
// 100dvh, поэтому это НЕ "складывается" с существующим поведением других
// платформ (ровно тот риск двойного сдвига, о котором явно предупреждает ТЗ).
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
