# src/platform/ — контракт платформенного адаптера

Единственный способ, которым остальной код узнаёт о платформе (§4.3
`PROCESS-DOCS/NATIVE-APPS/TZ-NATIVE-APPS.md`). Все методы асинхронные, если не
указано иное. Веб-реализация (`web.js`) повторяет текущее (до Э1) поведение
приложения один в один.

```js
platform = {
  shell: 'web' | 'capacitor' | 'tauri',
  os: 'web' | 'android' | 'ios' | 'windows' | 'macos' | 'linux',
  info(): { shell, os, appVersion, buildHash, engineVersion }, // для экрана «Диагностика»

  config: { load() },                       // runtime-конфиг (Р6)

  notifications: {                          // §4.3 — самостоятельная реализация,
    permission(), requestPermission(),      // ПОКА не подключена к notify()
    show({ id, title, body, tag, route }),  // (domain/notifications/backend.js —
    onClick(cb),                            // см. PROGRESS.md, Э1.3)
    setBadge(count),
  },

  media: {
    // Э2.1 — реализован на capacitor.js/tauri.js: в пределах лимита платформы
    // (desktop 1 ГиБ, Android 256 МБ, iOS 150 МБ) расшифровывает файл целиком
    // через существующий конвейер (getManifest/getRange) в Blob, отдаёт
    // { url, release() }; НЕ импортирует native SDK (media-native-fallback.js).
    // Больше лимита — Р2.2: владелец выбрал (А) «расшифровать во временный
    // файл, играть с диска» (2026-09-27) — throw до Э3/Э4 (нужен реальный
    // native/mobile или native/desktop проект, чтобы проверить запись на диск
    // через @capacitor/filesystem/@tauri-apps/plugin-fs — не реализовано вслепую).
    // web.js — throw: Э2.4, веб продолжает использовать SW-плеер напрямую,
    // этот метод там не вызывается.
    getPlayableSource(fileRef, { mime, size, onProgress })
  },

  files: {
    saveAs({ name, mime, data }),           // data: Blob | Uint8Array | ArrayBuffer | string
  },

  links: {
    openExternal(url),
    onDeepLink(cb),                         // Э7
  },

  lifecycle: {
    onResume(cb), onPause(cb), onNetworkChange(cb),
  },

  updates: {
    mode: 'sw' | 'store' | 'desktop-updater',
    check(), apply(),
  },

  ui: {
    setBackHandler(cb),
    setSystemBarsTheme('light' | 'dark'),
    setSecureScreen(on),
    keepAwake(on),
  },

  call: {
    begin({ peerName }), end(),
  },

  // Расширение контракта (Э1.1, приоритет владельца 2026-09-27 — см.
  // PUSH-DESIGN.md): стаб, реализации нет ни на одной платформе.
  push: {
    supported(),
    getToken(),
    onTokenChange(cb),
    onWake(cb),
  },
}
```

Добавлять методы можно; менять смысл перечисленных нельзя без записи в
`PROCESS-DOCS/NATIVE/PROGRESS.md`.

`capacitor.js`/`tauri.js` — `createPlatform()` возвращает рабочий объект:
`media.getPlayableSource` реализован (Э2.1, в пределах лимита платформы — не
требует native SDK), все остальные методы бросают `Error("… — ещё не
реализовано")` при первом вызове (`native-stub.js`) — реальные реализации
появятся вместе с `native/mobile` (Э3) и `native/desktop` (Э3/Э8).
`@capacitor/*`/`@tauri-apps/*` импортируются только из этих двух файлов
соответственно (§4.2) — статический `if (__TARGET__ === …)` в `index.js`
позволяет Rollup вырезать недостижимую ветку и весь её импорт из веб-бандла
(вынесение этого сравнения в отдельную функцию ломает вырезание — проверено
эмпирически, см. PROGRESS.md Э1).
