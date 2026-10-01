import { t } from "../signals/i18n.js";
import { getPlatform } from "../../platform/index.js";

// Э4.4 ТЗ-NATIVE-APPS — рендерится ВМЕСТО <App/> в main.jsx, когда движок
// WebView (Android) слишком стар (< Chromium 100): "не грузить приложение
// дальше" буквально — весь остальной код приложения (домен, IndexedDB,
// ключи и т.д.) НЕ инициализируется вовсе, не только не показывается.
export default function WebViewOutdated() {
	function handleUpdateClick() {
		// Playstore intent-ссылка на сам компонент WebView (не на "Уголок") —
		// стандартный package id системного компонента на всех Android-сборках
		// с Google Play (AOSP-сборки без Play вообще не имеют этого пути
		// обновления — для них показывается только текст, ссылка не откроется,
		// это ожидаемо и не наша ответственность чинить).
		Promise.resolve(getPlatform().links.openExternal("https://play.google.com/store/apps/details?id=com.google.android.webview")).catch(() => {});
	}

	return (
		<main class="center stack" style={{ "--measure": "32rem", paddingInline: "var(--space-m)", "--gap": "var(--space-m)", minBlockSize: "100dvh" }}>
			<h1>{t("webviewOutdated.title")}</h1>
			<p style={{ color: "var(--muted)" }}>{t("webviewOutdated.body", { appName: t("app.name") })}</p>
			<button type="button" class="btn btn-block" onClick={handleUpdateClick}>
				{t("webviewOutdated.updateButton")}
			</button>
		</main>
	);
}
