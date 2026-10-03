package tech.ugolok.app;

import android.os.Bundle;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import tech.ugolok.app.push.UgolokPushPlugin;

// Э4.7 ТЗ-NATIVE-APPS — найдено живьём (эмулятор, Android 16/API 36), позже
// переисследовано (v0.0.3, живая проверка на safe-area-inset-bottom):
// слушатель --keyboard-inset стоял на getWindow().getDecorView() — на ТОМ ЖЕ
// view, где плагин Capacitor SystemBars (insetsHandling: native) ставит свой
// собственный ViewCompat.setOnApplyWindowInsetsListener. Это не список, а
// слот с одним значением: наш вызов (после super.onCreate()) полностью
// подменял слушатель SystemBars, и его корректная пересборка инсетов
// (критичная для нижнего inset — см. SystemBars.java getBottomInset()) ни
// разу не выполнялась. Отсюда и "ime() всегда 0" (ложно приписано апстрим-
// багу), и env(safe-area-inset-bottom) всегда 0 в релизе. Фикс: вешаем свой
// слушатель на webView (потомок decorView), а не на decorView — диспетчеризация
// инсетов идёт сверху вниз, так что webView получает уже исправленные
// SystemBars инсеты, и оба механизма не конфликтуют.
public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		// Э4.10/Э-PUSH — registerPlugin ОБЯЗАН быть ДО super.onCreate(): Bridge
		// загружает уже зарегистрированные плагины внутри super.onCreate().
		registerPlugin(SecureScreenPlugin.class);
		registerPlugin(UgolokPushPlugin.class);
		super.onCreate(savedInstanceState);
		final android.webkit.WebView webView = getBridge().getWebView();
		// Живая проверка (v0.0.3→v0.0.4) — на WebView <140 (все реальные
		// устройства сейчас) SystemBars.insetsHandling=css физически ресайзит
		// WebView при каждом показе/скрытии клавиатуры (v.setPadding с
		// imeInsets.bottom), а дефолтный фон WebView/окна — белый. Пересоздание
		// поверхности при ресайзе на секунду показывает этот белый фон вместо
		// кремового фона приложения — отсюда "пугающая белая вспышка" при тапе
		// на поле ввода. Фикс не устраняет сам ресайз (это внутренняя логика
		// плагина, вне нашего кода), но меняет цвет "подложки" на тон фона
		// приложения по умолчанию, так что вспышка становится незаметной.
		webView.setBackgroundColor(android.graphics.Color.parseColor("#FCF8F3"));
		ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
			int imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
			webView.evaluateJavascript("document.documentElement.style.setProperty('--keyboard-inset','" + imeBottom + "px')", null);
			return insets;
		});
	}
}
