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

  media: {                                  // Э2 — throw до реализации
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

`capacitor.js`/`tauri.js` (Э1) — заготовки: `createPlatform()` бросает
`Error("не реализовано")`. Реальные реализации — Э3 (mobile) и Э3/Э8 (desktop).
`@capacitor/*`/`@tauri-apps/*` импортируются только из этих двух файлов
соответственно (§4.2) — статический `if (__TARGET__ === …)` в `index.js`
позволяет Rollup вырезать недостижимую ветку и весь её импорт из веб-бандла.
