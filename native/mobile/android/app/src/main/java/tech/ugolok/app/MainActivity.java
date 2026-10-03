package tech.ugolok.app;

import android.os.Bundle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import tech.ugolok.app.push.UgolokPushPlugin;

// Э4.7 → v0.0.3 → v0.0.4 ТЗ-NATIVE-APPS, живая проверка на реальном телефоне —
// SystemBars.insetsHandling (и "native", и "css") в какой-то из своих веток
// физически ресайзит WebView при КАЖДОМ показе/скрытии клавиатуры
// (ViewCompat.setOnApplyWindowInsetsListener на decorView → v.setPadding
// с imeInsets.bottom — так во ВСЕХ ветках SystemBars.java, не только в
// passthrough). Раньше (до фикса слушателя v0.0.4) этот ресайз был мёртвым
// кодом — MainActivity's собственный слушатель на decorView ПОЛНОСТЬЮ
// подменял слушатель SystemBars, и ресайз ни разу не выполнялся. Починив
// "конфликт слушателей" мы случайно ВПЕРВЫЕ включили этот ресайз — и
// получили живьём на телефоне: залипающий белый прямоугольник на месте
// клавиатуры и перевёрнутый (посимвольно) ввод текста ("Здесь" → "ьседЗ" —
// это точная сигнатура "новый символ всегда вставляется в начало", то
// есть Chromium теряет позицию курсора при каждом ресайзе WebView во время
// открытой клавиатуры). Это задокументированный, пока НЕ решённый в
// WebView <144 апстрим-баг (issues.chromium.org/issues/457682720 — тот же,
// на который ссылается сам SystemBars.java).
//
// Фикс — не чинить ресайз (нечем, это Chromium), а не ресайзить вовсе:
// забираем слушатель себе на decorView (так же, как раньше), insetsHandling
// плагина переведён в "disable" (сам плагин больше ничего с insets не
// делает), а top/right/bottom/left safe-area считаем и инжектим как
// --safe-area-inset-* CSS-переменные САМИ — без единого вызова setPadding,
// то есть WebView остаётся full-screen всегда, Android никогда его не
// ресайзит, баг с ресайзом в принципе не может произойти. CSS уже читает
// var(--safe-area-inset-*, env(safe-area-inset-*)) — работает независимо
// от версии WebView и без гонки с проверкой viewport-fit=cover.
public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		// Э4.10/Э-PUSH — registerPlugin ОБЯЗАН быть ДО super.onCreate(): Bridge
		// загружает уже зарегистрированные плагины внутри super.onCreate().
		registerPlugin(SecureScreenPlugin.class);
		registerPlugin(UgolokPushPlugin.class);
		super.onCreate(savedInstanceState);
		final android.webkit.WebView webView = getBridge().getWebView();
		final float density = getResources().getDisplayMetrics().density;
		ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (view, insets) -> {
			Insets sb = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
			int imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
			String script =
				"document.documentElement.style.setProperty('--safe-area-inset-top','" + (int) (sb.top / density) + "px');" +
				"document.documentElement.style.setProperty('--safe-area-inset-right','" + (int) (sb.right / density) + "px');" +
				"document.documentElement.style.setProperty('--safe-area-inset-bottom','" + (int) (sb.bottom / density) + "px');" +
				"document.documentElement.style.setProperty('--safe-area-inset-left','" + (int) (sb.left / density) + "px');" +
				"document.documentElement.style.setProperty('--keyboard-inset','" + imeBottom + "px');";
			webView.evaluateJavascript(script, null);
			return insets;
		});
		// Первый вызов слушателя (сразу после onCreate) ловит decorView ДО
		// того, как окно реально измерено системой — insets там нулевые.
		// SystemBars.java решает это тем же путём: ждёт onPageCommitVisible
		// и дёргает requestApplyInsets() ещё раз, когда реальные размеры уже
		// известны. Раньше (insetsHandling=css/native) этот путь был у
		// SystemBars; теперь, когда insets считаем сами (insetsHandling=
		// disable), нужно повторить тот же трюк самостоятельно.
		getBridge().addWebViewListener(new WebViewListener() {
			@Override
			public void onPageCommitVisible(android.webkit.WebView view, String url) {
				super.onPageCommitVisible(view, url);
				getWindow().getDecorView().requestApplyInsets();
			}
		});
	}
}
