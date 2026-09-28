package tech.ugolok.app;

import android.os.Bundle;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

// Э4.7 ТЗ-NATIVE-APPS — найдено живьём (эмулятор, Android 16/API 36):
// WebView не меняет размер при появлении клавиатуры (поле ввода может
// оказаться частично под ней), причём НИ ОДИН из трёх опробованных путей
// не помогает: android:windowSoftInputMode="adjustResize" (AndroidManifest.xml)
// не эффекта; window.visualViewport в самой странице не отражает клавиатуру
// (.height не меняется); WindowInsetsCompat.Type.ime() здесь тоже всегда 0,
// даже при видимой клавиатуре (dumpsys подтверждает: EDGE_TO_EDGE_ENFORCED,
// но insets на decorView не обновляются вовсе). Это подтверждённый, пока
// НЕ решённый апстрим-баг Capacitor 8 в edge-to-edge на Android 15/16
// (ionic-team/capacitor#7983, #8432) — не наш код, чинить героически не
// стали (сообщество само пока не нашло надёжный фикс). Слушатель оставлен
// как безвредная защита на будущее: если Google/Capacitor это когда-нибудь
// починят на уровне платформы, --keyboard-inset (custom.css's .shell,
// keyboard-inset.js) заработает сам, без изменений здесь.
public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		final android.webkit.WebView webView = getBridge().getWebView();
		ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (view, insets) -> {
			int imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
			webView.evaluateJavascript("document.documentElement.style.setProperty('--keyboard-inset','" + imeBottom + "px')", null);
			return insets;
		});
	}
}
