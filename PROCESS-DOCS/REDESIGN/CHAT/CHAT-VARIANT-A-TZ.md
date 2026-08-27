# ТЗ для терминального SuperGrok: чат, вариант A «Альбом»

Версия: 1.0  
Проект: `ugolok-03` (Preact, сигналы, без новых библиотек)  
Эталон внешнего вида: макет «Вариант A — Альбом» из `ugolok-chat-variants.html` (если файла нет под рукой — все размеры и сетки продублированы ниже, макет не обязателен для сборки).

Ты реализуешь **только вариант A**. Не делай группировку пузырей, не делай рельс «в этом чате», не делай композер-пилюлю варианта B, не переписывай стартовую, каналы-посты, оверлей медиа и протокол Nostr.

Если пункт ниже написан как ОБЯЗАТЕЛЬНО — его отсутствие = задача не сдана. Прошлый заход по стартовой странице закрыл ~30% формулировок. Здесь такого нельзя: каждый визуальный и поведенческий пункт имеет проверку.

---

## 0. Цель одной фразой

В личном чате с контактом несколько вложений больше не стоят столбиком с огромными кнопками «Скачать ИМЯ (размер)» и «Сохранить к себе». Медиа собираются в сетку ограниченной ширины, видео сразу видно как превью с Play, файлы — чипами, действия — в меню `⋯`, перед отправкой пачки пользователь выбирает раскладку.

---

## 1. Что НЕ входит в эту задачу

Запрещено делать «заодно», даже если кажется логичным:

- Варианты B и C (flush-медиа, группировка хвостов, правый рельс, magazine).
- Перенос markdown-тулбара, смена пилюли композера, новые жесты свайпа.
- Скачивание полного видео в пузырь / `<video src>` с eager-загрузкой всего файла.
- Новое top-level поле `attachmentsLayout` в MLS-payload (см. §3 — иначе его выкинет приёмник).
- Редизайн `post-card.jsx` и комментариев канала (они используют `splitBubbleAttachments`, его **нельзя ломать**).
- Смена лимита `MAX_ATTACHMENTS_PER_MESSAGE` (сейчас 10).
- Новые npm-зависимости, CSS-in-JS, иконки не из `src/ui/icons`.
- Рефакторинг `Screen`, роутера, темы, i18n-движка.

Можно и нужно попутно поменять общие компоненты (`MessageBubble`, `AttachmentTray`, `useAttachmentTray`), потому что их же рендерит чат канала и «Быстрая связь». Это ожидаемый побочный эффект, не расползание скоупа.

---

## 2. Как сейчас устроено (не выдумывать иное)

Прочитай целиком до правок:

| Файл | Зачем |
|---|---|
| `src/ui/components/message-bubble.jsx` | Пузырь: above/below, под каждым вложением Save, в футере Download на каждое |
| `src/ui/components/message-bubble-attachments.js` | `splitBubbleAttachments` — только первое `image` + `position==="above"` |
| `src/ui/components/attachment-view.jsx` | Image eager, Video = текстовая кнопка, File = строка, Save-кнопка при `origin` |
| `src/ui/components/media/attachment-tray.jsx` | Вертикальный список + радио «над/под» у картинок |
| `src/ui/hooks/attachment-tray-core.js` | Состояние лотка, `position` только у image |
| `src/ui/hooks/use-attachment-tray.js` | `uploadAll` копирует `position` только если `job.isImage` |
| `src/ui/screens/chat.jsx` | ChatWindow + ComposeMessage; FilePicker `multiple={false}` |
| `src/ui/components/channel-chat.jsx` | Тот же лоток и MessageBubble |
| `src/ui/screens/channel.jsx` | Лоток в посте/комменте; комментарии всё ещё через `splitBubbleAttachments` |
| `src/ui/screens/quick.jsx` | MessageBubble |
| `src/styles/custom.css` | `.message-bubble` `max-width:70%`; картинка внутри без лимита высоты |
| `src/domain/messaging/attachments.js` | Дескриптор: `type, manifestDigest, fileKey, mime, size, name` (+ `position` у image, `voice`/`voiceInline` у голоса) |
| `src/domain/messaging/chat.js` | В payload копируются целиком `attachments[]`. Поля **вне** массива (кроме `sentAt`) при приёме отбрасываются |
| `src/ui/components/actions-menu.jsx` | Готовое меню на `<details>` |
| `tests/message-bubble-attachments.test.js` | Контракт split |
| `tests/attachment-tray-core.test.js` | Контракт лотка |
| `src/ui/i18n/locales/*.json` | 12 локалей: ru en es de ja fr pt it nl pl tr zh |

Видео сейчас без превью **намеренно** (комментарий в `VideoAttachment`, этап F1). Этот запрет касается полной загрузки файла. Постер в дескрипторе и тёмная плитка без сети — разрешены и обязательны.

---

## 3. Контракт данных (критично)

### 3.1. Куда писать раскладку и постер

**Только внутрь элементов `message.attachments[]`.**  
Не добавляй `message.attachmentsLayout` в MLS-payload: `doReceiveGroupMessageEvent` собирает `extra` вручную и новое поле с сообщения молча пропадёт у получателя.

На **каждом визуальном** вложении (`type === "image" | "video"`) нового сообщения:

```js
{
  // уже существующие поля
  type, manifestDigest, fileKey, mime, size, name,
  position,          // для image можно оставить "below"; радио из лотка УБРАТЬ
  // НОВОЕ
  layout: "duo",     // одно и то же значение на всех visual этой пачки
  poster: "data:image/jpeg;base64,...", // только video, опционально
}
```

`file` и `audio` поле `layout` не несут.  
Голосовые не участвуют в сетке.

Чтение раскладки:

```
layout = первое visual-вложение с валидным layout
       ?? inferLayout(visualCount)
```

Валидные значения: `"single" | "duo" | "trio" | "quad" | "hero" | "stack"`.

Старые сообщения без `layout`: всегда `inferLayout`. Поведение `position === "above"` для **одного** старого изображения сохранить через существующий `splitBubbleAttachments` **только в post-card/комментариях**. В `MessageBubble` новый путь (кластер), `position` больше не двигает картинку над текстом.

### 3.2. Автовыбор

| Число visual (image+video) | inferLayout |
|---|---|
| 0 | нет кластера |
| 1 | `single` |
| 2 | `duo` |
| 3 | `trio` |
| 4 и больше | `quad` (в последней клетке бейдж `+N`, если visual > 4) |

Документы и не-голосовое аудио **всегда** списком чипов **под** текстом, вне сетки.

Порядок в пузыре:

1. визуальный кластер (если есть)
2. текст (`MarkdownView`, как сейчас)
3. чипы `file` + не-голосовое `audio`
4. голосовое — как сейчас, `<audio controls>`
5. футер: время, статус, «изменено», меню `⋯`

### 3.3. Обратная совместимость

- Сообщение без вложений — без изменений.
- Одно старое изображение — `single`, превью как сейчас (eager).
- Старое видео без `poster` — плитка-заглушка 16:10 с иконкой Play, именем **усечённым**, размером. **Не** растянутая `btn--ghost.media-attachment-preview`.
- Неизвестный `layout` → `inferLayout`.
- `voiceInline` не трогать.

---

## 4. Внешний вид варианта A (обязательные цифры)

Токены брать из приложения: `--accent`, `--accent-contrast`, `--surface-raised`, `--surface`, `--border`, `--muted`, `--fg`, `--radius`, `--space-*`, `--step-*`. Не хардкодить цвета макета `#e9b45e` — в бою палитра сменная.

### 4.1. Пузырь

`.message-bubble` оставить `max-width: 70%`.  
Добавить ограничение **кластера**, не всего пузыря:

```css
.bubble-media {
  width: min(100%, 20.5rem);
  max-width: 100%;
}
.bubble-media img,
.bubble-media .tile img {
  object-fit: cover;
}
```

Одиночное медиа (`single`): `aspect-ratio: 16 / 10`; `max-height: 16rem`; `border-radius` чуть меньше пузыря (≈ 0.85rem).  
Картинка больше не может быть «во весь ноутбук» по ширине и бесконечной по высоте.

На узком экране (`max-width: 640px`) пузырь может быть до `88%`, кластер всё равно `min(100%, 20.5rem)`.

### 4.2. Сетки (gap 3px, overflow hidden, общее скругление 0.85rem)

```
single:  одна плитка 16/10
duo:     1fr 1fr, плитки ≈ 1 / 1.05
trio:    grid 1.2fr 0.8fr / две строки; первая плитка grid-row: 1 / -1; высота кластера 13.2rem
quad:    2×2, плитки 1/1
hero:    сверху плитка 16/10, снизу лента height: 4.4rem из остальных (до 4)
stack:   вертикально, каждая 16/10, gap 3px (только если пользователь явно выбрал)
```

Плитка видео: затемнение снизу, круглая кнопка Play по центру, внизу слева подпись «видео» и длительность, если есть. Если длительности нет — только «видео» и `formatFileSize`.

Бейдж `+N`: полупрозрачный оверлей на 4-й клетке, белый текст, не перехватывает отдельный hit-area — клик открывает **этот** 4-й аттач в существующем media-overlay (плейлист уже строится в `openAttachment`).

### 4.3. Чипы файла и аудио

Не `<p>` на всю ширину и не `button` дефолтного акцента.

- высота ≈ 2.4rem, радиус 0.7rem, иконка 28px, имя одной строкой с ellipsis, под ним размер `step--2`.
- аудио: мини-волна как у `.audio .wave` (те же `AUDIO_WAVE_HEIGHTS` можно переиспользовать), без запуска плеера в пузыре — клик зовёт `onOpen`.
- внутри `.message-bubble-own` фон чипа = полупрозрачный `--accent-contrast`, текст `--accent-contrast`. Не оставлять тёмные чипы на лампе — это будет нечитаемо.

### 4.4. Кнопки, которых больше нет в потоке пузыря

Удалить из видимого потока пузыря:

- все `AttachmentDownloadLink` в футере;
- все `AttachmentSaveButton` под каждым вложением.

Они живут только внутри `ActionsMenu` пузыря.

Футер пузыря после правки: `время` · `статус` · `(изменено)` · кнопка `⋯`.  
«Редактировать» / «Удалить…» тоже в меню, не отдельными подчёркнутыми ссылками в футере (в макете A футер тихий). Режим `confirming-delete` и `editing` оставить теми же инлайн-состояниями, просто вход в них — из меню.

### 4.5. Шапка ChatWindow

Сейчас: «Позвонить» текстом + «Очистить переписку» красной кнопкой.

Сделать:

- «Позвонить» остаётся (иконка + короткий текст допустимы).
- «Очистить переписку» убрать из ряда шапки в `ActionsMenu` шапки (тот же `ActionsMenu`). Пункт меню с классом опасности, как принято у `.menu-pop button.danger` / `btn--danger`.
- Confirm `chat.window.clearHistoryConfirm` сохранить.

### 4.6. Лоток композера

Не вертикальный список карточек с радио.

Горизонтальный filmstrip:

- превью 52×52, радиус 0.65rem;
- image: object-url миниатюра (уже есть);
- video: миниатюра из `poster`, если есть, иначе тёмная плитка с ▶;
- file/audio: иконка + 2–3 буквы расширения;
- крестик 16px в углу = `onRemove`.

Под лентой — ряд раскладок, **только если visualCount >= 2**:

`2` `3` `4` `герой` `столбик`

Активная — обводка `--accent`.  
При visualCount < 2 ряда нет.

Радио «Над сообщением / Под сообщением» **удалить полностью**.

Под рядом раскладок мелкая подсказка: раскладка уйдёт в сообщение и так же отрисуется у собеседника.

Лоток используется в `chat.jsx` (окно + «Написать»), `channel-chat.jsx`, `channel.jsx`. Везде один новый вид.

---

## 5. Постер видео

Новый чистый модуль без JSX, например  
`src/ui/media/extract-video-poster.js`:

```
extractVideoPoster(file: File|Blob) -> Promise<string|null>
```

Алгоритм:

1. Если `!file.type.startsWith("video/")` → `null`.
2. `URL.createObjectURL` → `<video muted playsinline preload="metadata">`.
3. Дождаться `loadedmetadata`, seek на `min(0.1, duration/10 || 0)`.
4. На `seeked` нарисовать в canvas. Ширина кадра ≤ 480px, высота пропорционально.
5. `canvas.toBlob("image/jpeg", 0.62)`.
6. Если blob отсутствует или `blob.size > 32768` → `null` (потолок как у voiceInline).
7. Прочитать как data URL `data:image/jpeg;base64,...`.
8. Всегда revoke object URL и не оставлять висящих `<video>`.
9. Таймаут 4с → `null`, не бросать в UI.

Вызов:

- в лотке после `addFiles`, для каждого нового `type==="video"` с `item.file`;
- не блокировать добавление: превью появляется, когда промис резолвится;
- в `uploadAll` / `planUpload` копировать `poster` в дескриптор видео;
- файлы «из хранилища» без локального File — постера нет, в пузыре заглушка.

**Запрещено** для превью в пузыре: `getOrDownloadMessageAttachment` на видео. Сеть для постера не нужна — он уже в payload.

Тест на хелпер: с крошечным валидным или невалидным blob (без сети) функция возвращает `null` или строку `data:image/jpeg`. Не мокай весь DOM сверх необходимого; если в node нет полноценного video/canvas — вынеси ветку «нет Video/Canvas → null» и покрой её, плюс чистую функцию сборки data URL из bytes, если выделишь.

Практичный минимум тестов постера:

- type не video → null;
- size потолок: если передать опцией уже готовый oversized blob — null;
- revoke вызывается (можно через свой inject create/revoke).

Не вались на «в node нет video» — не оставляй модуль без тестов вообще.

---

## 6. Какие файлы создать / менять

### Создать

1. `src/ui/components/bubble-attachment-plan.js`  
   Чистые функции (сюда доменные решения, чтобы тестировать `node --test` без JSX):
   - `isVisual(a)`, `isFileChip(a)`, `isAudioChip(a)`, `isVoice(a)`
   - `inferLayout(n)`
   - `resolveLayout(attachments)`
   - `planBubbleAttachments(attachments) -> { layout, visual, files, audios, voices }`
   - visual сохраняет исходный порядок.

2. `src/ui/components/bubble-attachment-cluster.jsx`  
   Рендер кластера + чипов. Никакой загрузки манифеста здесь, кроме уже существующих Image-хелперов.

3. `src/ui/media/extract-video-poster.js`

4. `tests/bubble-attachment-plan.test.js`  
   Полная таблица infer/resolve/partition. Краевые: undefined, [], только pdf, 1 фото, 3 фото + pdf + mp3 + voice, неизвестный layout, layout на file игнорируется, 7 visual → quad и visual.slice(0,4) + overflow 3.

5. `tests/extract-video-poster.test.js` — что реально исполняется в node.

### Менять

| Файл | Что сделать |
|---|---|
| `message-bubble-attachments.js` | **Не менять поведение** `splitBubbleAttachments`. Файл остаётся для post-card/комментов. Можно добавить реэкспорт plan-функций, если хочешь одну точку, но сигнатуру split не ломать. Существующие 8 тестов должны пройти как есть. |
| `message-bubble.jsx` | Перейти на `planBubbleAttachments`. Кластер + текст + чипы + голос. Футер без Download. Меню `ActionsMenu`. Режимы editing / confirming-delete сохранить. |
| `attachment-view.jsx` | Вынести переиспользуемые `ImageAttachment` (или общий хук/загрузчик URL). `VideoAttachment` больше не `MediaPreview`-строка. `AttachmentView` с `origin` **не** рисует Save под превью, если вызывается из кластера. Save остаётся экспортом `AttachmentSaveButton` для меню. `AttachmentDownloadLink` остаётся экспортом для меню, визуально — пункт меню, не акцентная кнопка на всю ширину. |
| `attachment-tray.jsx` | Filmstrip + layout chips. Пропсы расширить: `layout`, `onLayoutChange`. Радио position удалить. |
| `attachment-tray-core.js` | Состояние: `layout` на уровне state (`null` или один из id). Функции `setTrayLayout`, при `addFiles`/`removeItem` пересчитывать: если visual < 2 → `layout = null` (уйдёт в infer при upload); если visual >= 2 и layout null → `inferLayout`. `position` у новых image всегда `"below"` (поле можно оставить в объекте, UI не показывает). В `planUpload` отдать `layout` и `poster`. |
| `use-attachment-tray.js` | Прокинуть `layout`, `setLayout`. В `uploadAll` для каждого visual-дескриптора `descriptor.layout = state.layout ?? inferLayout(visualCount)`; для video `descriptor.poster = item.poster` если есть. |
| `chat.jsx` | FilePicker `multiple={true}`. `handleAttachmentFromStorage(ids)` принимает массив, для каждого файла тот же manifest/fileKey путь, один confirm на пачку (не N окон confirm). Лоток: передать layout props. Шапка: меню вместо «Очистить». |
| `channel-chat.jsx` | То же для FilePicker + handler + пропсы лотка. |
| `channel.jsx` | Пропсы лотка (layout), иначе лоток сломается (новые обязательные колбэки сделать опциональными: `onLayoutChange` no-op по умолчанию). |
| `quick.jsx` | Не должен сломаться: MessageBubble API не сужать. Новые пропсы только опциональные. |
| `src/styles/custom.css` | Блок сразу после существующих правил `.message-bubble*` (~строка 1790). Новые классы: `.bubble-media`, `.bubble-media--single/duo/trio/quad/hero/stack`, `.bubble-tile`, `.bubble-tile-play`, `.bubble-tile-more`, `.bubble-filechip`, `.bubble-audiochip`, `.attach-tray`, `.attach-tray-thumb`, `.attach-layouts`. Не класть раскладку в инлайн-style, кроме `background-image` постера/миниатюры. |
| все 12 `src/ui/i18n/locales/*.json` | Ключи из §8. Не только ru и en. Если не уверен в переводе — для не-ru/en допустим английский текст, но **ключ должен существовать**, иначе `t()` пишет warn и показывает сырой ключ. |
| `tests/attachment-tray-core.test.js` | Дописать layout/poster/planUpload. Старые тесты position: либо оставить (position пишется below), либо поправить ожидание, если удалишь поле. Не удаляй тесты молча. |
| `PROCESS-DOCS/log.md` | Одна короткая запись, что сделан вариант A бабблов. Не раздувать DESIGN.md эссе. |

### Не трогать без нужды

`src/domain/messaging/chat.js` send/receive (attachments[] уже копируется целиком — poster/layout проедут).  
Если вдруг где-то санитайзят ключи дескриптора — добавить `layout` и `poster` в белый список. Перед сдачей `rg "position|manifestDigest|fileKey" src/domain` и проверить, нет ли стриппера полей вложения.

---

## 7. Поведение UI по шагам

### 7.1. Выбор файлов с диска

Как сейчас: hidden input `multiple`. После выбора filmstrip. Для видео стартует extract poster. Ошибки валидации — под превью, как сейчас `item.error`.

### 7.2. Выбор из хранилища

`FilePicker multiple={true}`.  
`onSelect(ids)`:

```
закрыть пикер
если ids пуст — return
confirm один раз chat.window.sendAttachmentConfirm
для каждого id:
  node = projected.nodes.get(id)
  если не file — skip
  manifest + fileKey; если нет ключа — собрать ошибку, остальные не бросать
  сложить в refs
tray.addFromStorage(refs)
сбросить голосовую запись, как сейчас
```

Сейчас confirm на один файл и `multiple={false}` — это дыра, её закрыть.

Тот же паттерн в `channel-chat.jsx`. В `ComposeMessage` (`chat.jsx`) лоток с диска уже multiple; из хранилища там нет FilePicker — не добавлять новый пикер «заодно».

### 7.3. Выбор раскладки

Клик по чипу пишет `state.layout`.  
Превью в лотке не обязано перестраиваться в ту же сетку (достаточно подсветки чипа). Сетка обязательна в отправленном пузыре.

Если пользователь собрал 4 visual, выбрал `hero`, потом удалил до 1 visual — layout сбросить, в дескриптор уйдёт `single`/infer.

### 7.4. Отправка

`uploadAll` уже вызывается до `sendChatMessageAction`. Дескрипторы с `layout`/`poster` попадают в `attachments` без изменения `sendMessage`.

Нельзя стрипать неизвестные поля при сборке дескриптора в `uploadMessageAttachmentStreaming` / `referenceStoredFile`. Дописывай поля **после** вызова этих функций (так уже делается с `position`).

### 7.5. Клик по плитке

Тот же `openWithOrigin` + `onOpenAttachment(message, attachment)`, что сейчас. Плейлист чата не переписывать.

### 7.6. Меню пузыря

Пункты, если соответствующий callback/вложение есть:

- Скачать {усечённое имя} — по одному на вложение, вызывает существующую логику DownloadLink
- Сохранить к себе {усечённое имя} — по одному, существующий Save
- Редактировать — только isOwn + onEdit
- Удалить — включает mode confirming-delete

Имена длиннее 24 символов: `abc…xyz.mp4` или простой slice + ellipsis. В меню не должно быть кнопки шириной с «Скачать UzPRZ2iM8Bw6e7ui.mp4 (2.1 МБ)».

Голосовое: скачать можно, «открыть» не через overlay.

---

## 8. i18n-ключи

Добавить во все 12 локалей. Русские эталоны:

```
attachment.layoutGroup          Раскладка вложений
attachment.layoutDuo            2
attachment.layoutTrio           3
attachment.layoutQuad           4
attachment.layoutHero           Герой
attachment.layoutStack          Столбик
attachment.layoutHint           Раскладка сохранится в сообщении и так же покажется собеседнику
attachment.videoBadge           видео
attachment.moreCount            +{{count}}
attachment.actionsMenuAria      Действия с сообщением
attachment.downloadNamed        Скачать {{name}}
attachment.saveNamed            Сохранить к себе {{name}}
chat.window.chatMenuAria        Действия чата
chat.window.clearHistoryMenu    Очистить переписку
```

Существующие `attachment.download`, `attachment.saveToStorage`, `attachment.openVideoAria` не удалять — могут использоваться в меню/оверлее.

Проверка сдачи: `rg "attachment.layoutHint" src/ui/i18n/locales | wc -l` → 12.

---

## 9. Тесты — обязательный набор

Запуск: `node --test tests/bubble-attachment-plan.test.js tests/message-bubble-attachments.test.js tests/attachment-tray-core.test.js tests/extract-video-poster.test.js tests/messaging-attachments.test.js`

Минимум кейсов plan:

1. undefined / [] → пустые массивы, layout `single` или отдельный `null` — зафиксируй одно и тестируй его.
2. 1 image → visual[1], layout single.
3. 2 video → duo.
4. 3 image → trio.
5. 4 image → quad.
6. 6 image → layout quad, visual.length 6 (обрезание только в рендере, не в plan).
7. image+video+pdf+mp3+voice → visual 2, files 1, audios 1, voices 1.
8. layout `"hero"` на первом visual → resolve hero, даже если visual 2 (infer был бы duo).
9. layout `"nope"` → infer.
10. layout на pdf игнорируется.

tray-core:

11. после 2 картинок layout авто `duo`.
12. setTrayLayout(`hero`) сохраняется.
13. remove до 1 сбрасывает layout.
14. planUpload прокидывает layout на visual и не вешает его на pdf.
15. poster с item уходит в job/дескриптор-план.

splitBubbleAttachments: **0 изменений ожиданий**.

Если сломаешь `messaging-attachments.test.js` — чини, не пропускай.

---

## 10. Визуальный QA (сделай сам, отметь пункты)

Открой экран чата с контактом (dev) или собери статическую ленту, если живой relay недоступен. Проверь глазами:

- [ ] Одно фото: не шире ~20.5rem, высота ограничена, скругление есть.
- [ ] Два фото: две клетки рядом, не столбик.
- [ ] Три: большая слева, две справа. Не 3 squashed в ряд и не столбик.
- [ ] Четыре: 2×2.
- [ ] Пять: 2×2 и `+1` на последней.
- [ ] Фото+видео+pdf+mp3 в одном сообщении: сетка только из фото/видео, под текстом два чипа.
- [ ] Видео без постера: плитка, Play, нет длинной ghost-кнопки на всю ширину пузыря.
- [ ] Видео с постером: виден кадр, не чёрный квадрат без смысла.
- [ ] Свои пузыри: чипы читаются на `--accent`.
- [ ] Чужие пузыри: чипы читаются на `--surface-raised`.
- [ ] В футере нет «Скачать … (2.1 МБ)».
- [ ] Под превью нет «Сохранить к себе».
- [ ] `⋯` открывает меню, Escape/клик снаружи закрывает (уже делает `useDetailsMenu`).
- [ ] Лоток: горизонтальные 52px превью, радио «над/под» нет.
- [ ] Один файл в лотке — ряда раскладок нет.
- [ ] Два+ visual — ряд есть, выбор живой.
- [ ] Шапка: нет красной «Очистить переписку» в первом ряду; пункт есть в меню.
- [ ] Текстовое сообщение без файлов выглядит как раньше (хвост, цвета, markdown).
- [ ] Голосовое по-прежнему отдельный плеер, не клетка сетки.
- [ ] Светлая и тёмная тема, минимум одна смена акцента в настройках — сетка не разъезжается.
- [ ] Ширина 360px и 1280px: на 1280 медиа не растягивается на пол-экрана.

Скриншоты не обязательны. Обман «в коде есть классы, в UI столбик» = не сдано.

---

## 11. Частые способы завалить задачу (запрещены)

1. Поменять только CSS `max-width` у `img` и оставить столбик View + Save + Download.
2. Включить готовый `.mgrid` постов (`minmax(6.5rem, 1fr)` auto-fill) вместо фиксированных duo/trio/quad/hero.
3. Добавить `attachmentsLayout` рядом с `text` в payload и не прокинуть через receive — у собеседника всегда infer.
4. Для видео вставить `<video src={eagerUrl} preload>` — это вернёт старую «какофонию» и сеть в ленте.
5. Оставить `AttachmentView origin` обёртку в кластере — снова кнопки «Сохранить к себе» под каждой плиткой.
6. Обновить только `ru.json`.
7. Сломать `splitBubbleAttachments` и «поправить» тесты так, чтобы post-card отъехал.
8. Сделать layout только в лотке и не записать в дескриптор — после перезагрузки/у другого пользователя сетка другая.
9. FilePicker так и оставить `multiple={false}`.
10. Сказать «меню потом» и оставить Download в футере.
11. Инлайн-style на 40 строк сетки вместо классов в `custom.css`.
12. Новые иконки эмодзи в лотке вместо существующих `src/ui/icons/*` в боевом UI (в текущем лотке эмодзи уже есть — **заменить** на иконки проекта, раз уж трогаешь файл).

---

## 12. Порядок работы (не прыгать)

1. Прочитать все файлы из §2.  
2. Написать `bubble-attachment-plan.js` + тесты, зелёный прогон.  
3. Постер-хелпер + тесты насколько возможно.  
4. CSS-классы сеток и чипов.  
5. `bubble-attachment-cluster.jsx` + переключить `message-bubble.jsx`.  
6. Убрать Download/Save из потока, встроить `ActionsMenu`.  
7. Лоток + core + hook + i18n.  
8. `chat.jsx` шапка и FilePicker multiple; то же в `channel-chat.jsx`.  
9. Прогнать тесты §9 и соседние `tests/chats-signals.test.js` `tests/chat.test.js` если заденешь сигнатуру send.  
10. Пройти чеклист §10.  
11. Запись в `PROCESS-DOCS/log.md`.

Коммит-сообщение (если просят коммит):  
`ui(chat): альбомная сетка вложений в пузыре, превью видео, лоток раскладок`

---

## 13. Критерий «готово»

Задача сдана, только если истинны все пункты:

- В `MessageBubble` при 2+ visual нет вертикального стека полноширинных превью.
- Кнопок «Скачать {оригинальное длинное имя} ({размер})» в футере пузыря нет.
- Кнопок «Сохранить к себе» под плитками нет.
- Видео в пузыре — плитка с Play, не `media-attachment-preview` строка.
- Ширина медиа ограничена 20.5rem.
- `layout` и `poster` едут внутри `attachments[]` и переживают send/receive без правок whitelist extra (проверь чтением `chat.js` receive).
- Лоток умеет выбрать hero/duo/trio/quad/stack, выбор попадает в дескриптор.
- `splitBubbleAttachments` и его 8 тестов без изменения контракта.
- Ключи i18n есть в 12 локалях.
- Тесты §9 зелёные.
- Чеклист §10 пройден исполнителем, не «оставил на потом».

Если какой-то пункт упёрся в реальный блокер (нет canvas в тестах, нет живого UI) — напиши это явным списком «не сделано / почему / как проверить вручную». Молча выкидывать пункт нельзя.
