# PLAN — Мессенджер "Уголок"

Подробное техническое задание в файле TECH.md

Статусы: [ ] не начат · [~] в работе · [x] принят (DoD выполнен, коммит есть)

- [ ] Этап 1. **Каркас проекта** — Vite + Preact + vite-plugin-singlefile; приложение открывается в браузере, рендерит интерфейс с aside с навигацией (контакты, сообщения, подписки, настройки, профиль и все остальное) и контентной областью где меняются заглушки
    - `vite.config.js`, `index.html`, `src/main.jsx`

- [ ] Этап 2. **Service Worker + конфиг** — кэширование по `BUILD_HASH`, `skipWaiting` + `clients.claim`, старый кэш чистится при обновлении; `config.js` со списком relay
    - `service-worker.js`, `src/config.js`

- [ ] Этап 3. **IndexedDB-схема + event-log** — все таблицы Dexie создаются (видны в DevTools), `appendEvent` / `queryEvents` / `getEventById` / `hasEvent` с `*flatTags`
    - `src/core/store/database.js`, `src/core/store/event-log.js`

- [ ] Этап 4. **Валидатор событий + CRDT-примитивы** — `validateEventId` (NIP-01 canonical serialization + SHA-256), G-Set (idempotent merge), LWW (tiebreaker по `id`); юнит-тесты проходят
    - `src/domain/events/validators.js`, `src/core/sync/g-set.js`, `src/core/sync/lww.js`

- [ ] Этап 5. **App shell + hash-роутер + outbox-заглушка** — навигация между `#/onboarding`, `#/main`, `#/unlock` (экраны-заглушки); persistent queue outbox (скелет)
    - `src/app.jsx`, `src/ui/router.js`, `src/core/store/outbox.js`

- [ ] Этап 6. **Воспроизводимая сборка (NF-18)** — `--frozen-lockfile`, детерминированный `vite build`, скрипт публикации и подписи хеша `index.html`, инструкция верификации
    - `scripts/release-hash.sh`, `docs/verify.md`

- [ ] Этап 7. **Деривация ключей (NIP-06)** — генерация/импорт мнемоники BIP-39, BIP-32 → secp256k1 pubkey/privkey; smoke-test §16.1 проходит
    - `src/core/crypto/mnemonic.js`, `src/core/crypto/keys.js`

- [ ] Этап 8. **KeyStore + деривация секретов** — шифрование privKey паролем (ChaCha20-Poly1305), деривация masterSecret / dbKey через HKDF, `opaqueDTag()` (HMAC обфускация)
    - `src/core/crypto/keystore.js`, `src/core/crypto/derivation.js`

- [ ] Этап 9. **Подпись + NIP-44 + NIP-59** — `sign`/`verify`, `encrypt`/`decrypt` NIP-44, `wrap`/`unwrap` NIP-59 (gift wrap/seal/rumor); все round-trip тесты проходят
    - `src/core/crypto/sign.js`, `src/core/crypto/nip44.js`, `src/core/crypto/nip59.js`

- [ ] Этап 10. **Файловое шифрование + crypto worker** — `encryptFile`/`decryptFile` (random key → ChaCha20 → upload pipeline), batch verify подписей в Web Worker через Comlink
    - `src/core/crypto/file-crypto.js`, `src/workers/crypto.worker.js`

- [ ] Этап 11. **Экран онбординга** — 3 варианта входа (создать новый / импорт мнемоники / вход по существующему ключу), отображение 12 слов с подтверждением, ввод и подтверждение пароля
    - `src/ui/screens/onboarding.jsx`, `src/ui/components/mnemonic-display.jsx`

- [ ] Этап 12. **Auth-состояние + экран unlock** — после онбординга → главный экран; lock после 24ч idle (очистка in-memory секретов); экран unlock с повторным вводом пароля; перезагрузка вкладки восстанавливает состояние
    - `src/ui/signals/auth.js`, `src/ui/screens/unlock.jsx`

- [ ] Этап 13. **MLS-спайк** — пин `ts-mls`, прогон 785/785 тест-векторов IETF MLS в CI; обвязка NIP-EE (kind 445, `h`-тег с group-id, fan-out); модель owner + device-members; документированные решения для фаз 3/6/8
    - `src/core/crypto/mls-session.js`, `src/domain/events/kinds.js`

- [ ] Этап 14. **Шифрование БД + конечные автоматы** — `db-crypto` (ChaCha20-Poly1305 на dbKey), `encrypted-table` (прозрачная обёртка над Dexie: put→encrypt, get→decrypt); прямой dump IndexedDB без ключа = `{nonce, data}` без plaintext; generic FSM (`transitions[state][event] → state`)
    - `src/core/crypto/db-crypto.js`, `src/core/store/encrypted-table.js`, `src/core/fsm/machine.js`

- [ ] Этап 15. **Relay pool + pluggable транспорт** — автомат соединений (§9.3), реконнект с backoff; абстракция транспорта: список endpoint, WSS через фронтинг (CDN/обратный прокси), фоллбэк при блокировке (NF-17)
    - `src/core/transport/relay-pool.js`, `src/core/transport/transport.js`

- [ ] Этап 16. **NIP-42 AUTH** — challenge → sign kind 22242 → response; replay-окно ±60с; не-whitelist pubkey получает `OK auth false` и dalej не подключается
    - `src/core/transport/relay-auth.js`

- [ ] Этап 17. **Publisher + subscriber + outbox** — публикация событий с batching (100 evt / 200мс); подписки по фильтрам; outbox: drain при восстановлении сети (offline → online → автодоставка)
    - `src/core/transport/publisher.js`, `src/core/transport/subscriber.js`, `src/core/store/outbox.js`

- [ ] Этап 18. **Lamport-часы + bootstrap cold start + P-SPIKE** — tick (in-mem), receive, persist (в транзакции с записью события), init из max(lamportTs); полная загрузка состояния при первом входе (скачать + fold + батч); P-SPIKE: 5000 синтетических событий через пайплайн ≤ 30с (NF-09)
    - `src/core/sync/lamport.js`, `src/core/sync/bootstrap.js`

- [ ] Этап 19. **Инкрементальная синхронизация + профиль** — realtime-подписки на новые события; kind 0 (профиль: имя, аватар) и kind 10002 (relay-list); индикатор синхронизации (подключён / syncing / оффлайн); проверка clock skew > 30с → предупреждение
    - `src/core/sync/incremental-sync.js`, `src/domain/identity/profile.js`, `src/ui/components/sync-indicator.jsx`

- [ ] Этап 20. **Битовая маска прав + журнальный движок** — ACTIONS bitmask (VIEW/COMMENT/MANAGE/…), append-only журнал подписанных permission-событий упорядоченных Lamport, `rebuildCache` свёрткой журнала в эффективную маску, монотонный revoke (невозможно «вернуть» отозванное право)
    - `src/domain/auth/bitset.js`, `src/domain/auth/permissions.js`, `src/domain/auth/engine.js`

- [ ] Этап 21. **Контакты + группы + блокировка + NIP-09** — kind 3 (контакт-лист), kind 30050 (группы), блокировка; fold для kinds 3/30050/30051; удаление событий (kind 5): автор может удалить своё, чужое kind 5 игнорируется
    - `src/domain/contacts/contacts.js`, `src/domain/contacts/groups.js`, `src/domain/events/handlers.js`

- [ ] Этап 22. **UI контактов + редактор прав** — экран списка контактов и групп, создание/удаление группы, permission-editor (grant/revoke VIEW и COMMENT на контакты и группы), signals для реактивности
    - `src/ui/screens/contacts.jsx`, `src/ui/components/permission-editor.jsx`, `src/ui/signals/contacts.js`

- [ ] Этап 23. **Личные сообщения — ядро** — ДКА сообщения (sending/sent/delivered/failed), `sendMessage` / `receiveMessage` через NIP-17 + MLS-интеграция (kind 445), двойной gift wrap (для получателя + для self-mirror), whitelist-after-unwrap для inbox-requests
    - `src/domain/messaging/chat.js`, `src/domain/messaging/machine.js`, `src/domain/messaging/inbox-requests.js`

- [ ] Этап 24. **Lazy-load чата + read status + черновики** — подгрузка истории при открытии чата (окнами по 100, подписка по chatId); счётчики непрочитанного (kind 30070, fold → unread); сохранение черновиков (kind 30071)
    - `src/core/sync/lazy-chat.js`, `src/domain/messaging/read-status.js`, `src/domain/messaging/drafts.js`

- [ ] Этап 25. **UI чата** — экран чата (input + список сообщений), message-bubble (входящее/исходящее, статусы), вкладка inbox (запросы от незнакомцев), принять → перенос в чат; удаление сообщения автором → «Сообщение удалено»
    - `src/ui/screens/chat.jsx`, `src/ui/components/message-bubble.jsx`

- [ ] Этап 26. **Blossom-клиент + загрузка/скачивание файлов** — собственный HTTP-клиент (~100 LOC): PUT с auth event kind 24242, GET без auth; валидация MIME (F-AT-05) и размера (F-AT-04: image/file ≤20 MB, video ≤20 MB); e2e-шифрование (random key → ChaCha20 → upload)
    - `src/core/transport/blossom-client.js`, `src/domain/attachments/upload.js`, `src/domain/attachments/validation.js`

- [ ] Этап 27. **Превью + голосовые + UI вложений** — client-side resize изображений (max 400×700) + poster видео через Canvas; голосовой рекордер (MediaRecorder, inline ≤32 KB raw — иначе через Blossom); UI: file picker, attachment-preview, transfer-progress, voice-recorder-widget
    - `src/domain/attachments/thumbnails.js`, `src/domain/attachments/voice.js`, `src/ui/components/attachment-preview.jsx`

- [ ] Этап 28. **Ключи каналов + comment allowlist** — генерация / версионирование / ротация channel key; шифрование ключа для читателя (NIP-44); `build`/`sign`/`verify` allowlist комментариев (kind 30054, подпись владельца канала)
    - `src/core/crypto/channel-key.js`, `src/core/crypto/comment-allowlist.js`, `src/domain/content/channel-access.js`

- [ ] Этап 29. **Посты + комментарии + lazy-load канала** — создание канала (channelKey + channelTopic), создание поста (ДКА post-machine), добавление комментария с локальной проверкой allowlist + верификацией при получении (F-EV-06); подгрузка контента по channelTopic окнами
    - `src/domain/content/channel.js`, `src/domain/content/post.js`, `src/domain/content/comments.js`

- [ ] Этап 30. **UI канала + настройки + финализация** — экран канала (список постов, читателей), post-card, comment-thread (дерево); настройки: профиль, relay-list, Blossom-серверы, тема (светлая/тёмная), lock now (kind 30072); финальный tree-shaking + замеры (AC-11: ≤280 KB gzip); бенчмарк bootstrap 1k/5k; self-hosting docs; E2E прогон всех AC
    - `src/ui/screens/channel.jsx`, `src/ui/screens/settings.jsx`, `src/ui/components/post-card.jsx`

## Заметки по этапам
(заполняется по ходу: решения, отложенные находки, изменения контрактов)