package tech.ugolok.app;

import android.os.Bundle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import tech.ugolok.app.push.UgolokPushPlugin;

// Единственный источник правды для системных отступов и клавиатуры:
// SystemBars.insetsHandling="disable" (capacitor.config.json) — плагин
// сам ничего с insets не делает, WebView остаётся full-screen всегда и
// никогда не ресайзится Android'ом (ресайз на каждое появление IME —
// задокументированный баг Chromium на WebView <144, issues.chromium.org/
// issues/457682720: теряется позиция курсора при вводе). Вместо этого
// слушатель ниже сам считает top/right/bottom/left safe-area и высоту
// клавиатуры из WindowInsetsCompat и инжектит их в CSS-переменные
// --safe-area-inset-* / --keyboard-inset, которые читает custom.css
// (var(--safe-area-inset-*, env(safe-area-inset-*)) и .shell's calc()).
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
			// IME-инсет меряется от низа экрана, поэтому уже включает в себя
			// зону нижней системной панели под клавиатурой — без вычитания
			// sb.bottom .shell учёл бы эту зону дважды (и своим padding, и
			// через --keyboard-inset).
			int keyboardOverlapPx = Math.max(0, imeBottom - sb.bottom);
			String script =
				"document.documentElement.style.setProperty('--safe-area-inset-top','" + (int) (sb.top / density) + "px');" +
				"document.documentElement.style.setProperty('--safe-area-inset-right','" + (int) (sb.right / density) + "px');" +
				"document.documentElement.style.setProperty('--safe-area-inset-bottom','" + (int) (sb.bottom / density) + "px');" +
				"document.documentElement.style.setProperty('--safe-area-inset-left','" + (int) (sb.left / density) + "px');" +
				"document.documentElement.style.setProperty('--keyboard-inset','" + (int) (keyboardOverlapPx / density) + "px');";
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
