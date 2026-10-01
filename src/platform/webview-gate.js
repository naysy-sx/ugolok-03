// Э4.4 ТЗ-NATIVE-APPS — "проверка движка WebView при старте. Если Chromium
// < 100, показать экран «Обновите Android System WebView»... и не грузить
// приложение дальше". Только Android/Capacitor: Chromium — это UA-подстрока
// самого движка ("Mobile Safari/537.36" общая для всех WebKit-based, а
// "Chrome/N" специфична для Chromium/Android WebView — обновляется системным
// компонентом "Android System WebView"/Chrome отдельно от версии Android).
// Desktop (Tauri/WKWebView/WebKitGTK/WebView2) сюда не попадает — контракт
// ТЗ (раздел 5, п. "Android: minSdk по требованию Capacitor + проверка версии
// движка WebView ≥ Chromium 100 при старте") ограничен Android явно.
const MIN_CHROMIUM_MAJOR = 100;

// Экспортировано отдельно от проверки для юнит-тестов: реальный UA Android
// WebView выглядит как "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/
// 537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/
// 537.36" — "Version/4.0" это версия WebView-обёртки (всегда 4.0, не движка),
// "Chrome/120..." — настоящая версия Chromium.
export function parseChromiumMajorVersion(userAgent) {
  const match = /\bChrome\/(\d+)\./.exec(String(userAgent ?? ""));
  return match ? Number(match[1]) : null;
}

// null (строка без "Chrome/N" вовсе) считается "не прошёл" — на реальном
// Android WebView эта подстрока есть всегда (см. выше); отсутствие означает
// либо будущий полный редизайн UA-строки, либо саму проверку, вызванную не
// на том движке — безопаснее заблокировать явно, чем молча пропустить.
export function isChromiumTooOld(userAgent) {
  const major = parseChromiumMajorVersion(userAgent);
  return major === null || major < MIN_CHROMIUM_MAJOR;
}

export { MIN_CHROMIUM_MAJOR };
