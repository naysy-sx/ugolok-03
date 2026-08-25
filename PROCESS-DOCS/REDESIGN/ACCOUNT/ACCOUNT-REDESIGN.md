# ТЗ: переработка «Профиля», «Настроек» и новый экран «Ключ и восстановление»

**Куда положить файл:** `PROCESS-DOCS/REDESIGN/ACCOUNT-REDESIGN.md`
**Референс-макеты:** `settings-B.html`, `profile.html`, `security.html`
(даются отдельно, в сборку не идут)
**Предшествующая задача:** `JOURNAL-REDESIGN.md` — её правки §6.1 (одна линия
под шапкой) частично повторяются здесь. Если «Журнал» уже сделан, часть
правил CSS уже будет в файле; см. §5, там это отмечено.

---

## 0. Правила работы для исполнителя

Прочитай раздел до конца, прежде чем открывать хоть один файл.

1. **Не импровизируй.** Ниже приведён полный текст новых файлов и полные
   тексты новых `return`-блоков. Вставляй как есть. Замечания вынеси
   отдельным списком в конце отчёта, но сначала сделай по ТЗ.
2. **Логику не трогаем — переезжает разметка.** Все обработчики,
   `useEffect`, вызовы домена в `profile.jsx` и `settings.jsx` остаются
   ПОБУКВЕННО теми же. Меняется только то, что возвращает `return`, и то,
   в каком файле функция живёт. Если по ходу работы захотелось «заодно
   поправить» вызов домена — не надо.
3. **Не расширяй область работы.** Список файлов — §1.
4. **Регламент раскладки обязателен** — `PROCESS-DOCS/REGLAMENT.md`.
   Композиционные классы (`.stack/.row/.bar/.reel/.grow/.rigid/.layer/
   .truncate/.box/.scroller/.self-end/.over`) держат раскладку, классы
   проекта — только вид. Ни `margin` на компонентах, ни чисел вне токенов,
   ни `@media` вне оболочки, ни физических свойств.
5. **Порядок этапов строгий:** §3 → §4 → §5 → §6 → §7 → §8 → §9. После
   каждого — `npm test`, тесты обязаны быть зелёными.
6. Комментарии в коде — на русском, в стиле проекта: объясняй ПРИЧИНУ, а
   не пересказывай код.

---

## 1. Файлы

| Файл | Что с ним |
|---|---|
| `src/ui/screens/security.jsx` | **новый файл** (§3) |
| `src/ui/screens/profile.jsx` | вырезаются четыре секции, заменяется `return` (§4) |
| `src/ui/screens/settings.jsx` | принимает вырезанное, заменяется `return` (§6) |
| `src/ui/components/account-card.jsx` | два пункта меню сводятся в один (§7) |
| `src/app.jsx` | маршрут `security`, проп меню (§7) |
| `src/styles/custom.css` | новый блок + три точечные правки (§5) |
| `src/ui/i18n/locales/*.json` (все 12) | ключи (§8) |

Всё остальное — не трогать.

---

## 2. Куда что переезжает (карта, читать до кода)

Правило разделения, по которому всё дальше устроено:

- **Профиль** — то, что видят другие, и последствия того, кто ты.
- **Настройки** — как приложение ведёт себя у тебя.
- **Ключ и восстановление** — то, что нельзя потерять.

| Что | Откуда | Куда |
|---|---|---|
| `RelayListEditor`, `ServerListEditor`, `RelayBlossomSection` | profile.jsx | settings.jsx, вкладка «Сеть» |
| `SelfHostedSection` | profile.jsx | settings.jsx, вкладка «Сеть» |
| Заглушка «Файлы — скоро» | profile.jsx | **удаляется совсем** |
| `DeleteAccountPanel` | settings.jsx | profile.jsx, «Опасная зона» |
| `MnemonicReveal` | settings.jsx | security.jsx |
| Переключатель темы | только меню учётной записи | settings.jsx, вкладка «Вид» (в меню остаётся) |

**`VisibilitySection` остаётся в profile.jsx.** Видимость в «Знакомствах» —
это про то, что видят другие.

**Чего в проекте НЕТ и что нельзя выдумывать.** Внутриприложенного
восстановления по фразе не существует: единственный такой поток —
`import-mnemonic` в `unlock.jsx`, он доступен ДО входа. Смены пароля не
существует вовсе. Поэтому на экране «Ключ и восстановление» **нет** ни
формы ввода фразы, ни смены пароля — есть объяснение и кнопка, которая
вызывает существующий `lock()` и тем самым приводит человека на экран
входа, где живой поток восстановления уже есть. Не добавляй ничего сверх
этого.

---

## 3. Новый файл `src/ui/screens/security.jsx`

Создать с этим содержимым, дословно:

```jsx
import { useState, useEffect } from "preact/hooks";
import { currentUser, dbKeySig, lock } from "../signals/auth.js";
import { listAccounts } from "../../core/crypto/keystore.js";
import Screen from "../components/screen.jsx";
import MnemonicReveal from "../components/mnemonic-reveal.jsx";
import IconKey from "../icons/key.jsx";
import IconShield from "../icons/shield.jsx";
import { t } from "../signals/i18n.js";

// Пункты меню учётной записи "Секретная фраза" и "Восстановить доступ"
// вели ОБА в "Настройки", в верх страницы из девяти разделов: меню
// обещало два места и приводило в одно, причём не туда. Здесь оба
// обещания выполняются, и меню сводится к одному пункту (account-card.jsx).
//
// ВАЖНО про восстановление: внутриприложенного потока восстановления по
// фразе не существует — единственный такой поток (import-mnemonic,
// unlock.jsx) доступен ДО входа. Поэтому здесь не форма, а объяснение и
// кнопка, ведущая туда, где поток есть: lock() выгружает ключи и
// возвращает на экран входа. Не заменять это собственной формой — она
// была бы дублирующей реализацией криптографического пути.
export default function Security() {
	const ownerPubkey = currentUser.value.id;
	const [hasMnemonic, setHasMnemonic] = useState(false);

	useEffect(() => {
		listAccounts().then((accounts) => {
			setHasMnemonic(!!accounts.find((a) => a.id === ownerPubkey)?.hasMnemonic);
		});
	}, [ownerPubkey]);

	return (
		<Screen title={t("security.title")}>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
				<section class="panel stack" style={{ "--gap": "var(--space-m)" }}>
					<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
						<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
							<IconKey />
							{t("security.mnemonicTitle")}
						</h2>
						<p class="panel__hint">{t("security.mnemonicHint")}</p>
					</div>
					<div class="callout callout--warn row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
						<span class="grow">{t("security.mnemonicWarning")}</span>
					</div>
					<MnemonicReveal ownerPubkey={ownerPubkey} hasMnemonic={hasMnemonic} />
				</section>

				<section class="panel stack" style={{ "--gap": "var(--space-m)" }}>
					<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
						<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
							<IconShield />
							{t("security.recoverTitle")}
						</h2>
					</div>
					<p class="panel__hint">{t("security.recoverBody")}</p>
					<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
						<button type="button" class="btn--ghost rigid" onClick={() => lock()}>
							{t("security.recoverButton")}
						</button>
					</div>
				</section>
			</div>
		</Screen>
	);
}
```

`dbKeySig` в импортах не используется — **убери его из строки импорта**
при вставке (оставлен в примере только чтобы ты не искал, откуда берётся
`lock`).

### 3.1. Две новые иконки

`src/ui/icons/key.jsx`:

```jsx
// Ключ — экран "Ключ и восстановление". Самодельный контур в стиле
// заливных Radix-иконок проекта (viewBox 0 0 15 15, currentColor, em).
export default function IconKey(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M9.5 1a4.5 4.5 0 0 0-4.3 5.82L1.15 10.9a.5.5 0 0 0-.15.35V13.5a.5.5 0 0 0 .5.5h2.25a.5.5 0 0 0 .35-.15l.9-.9V11.5a.5.5 0 0 1 .5-.5h1.45l1.2-1.2A4.5 4.5 0 1 0 9.5 1zm1.25 3.75a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"
				fill="currentColor"
			/>
		</svg>
	);
}
```

`src/ui/icons/shield.jsx`:

```jsx
// Щит — раздел восстановления доступа.
export default function IconShield(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M7.5 1 2.5 3v4.2c0 3.1 2.06 5.9 5 6.8 2.94-.9 5-3.7 5-6.8V3l-5-2zm0 1.1 4 1.6v3.5c0 2.5-1.6 4.8-4 5.7-2.4-.9-4-3.2-4-5.7V3.7l4-1.6z"
				fill="currentColor"
			/>
		</svg>
	);
}
```

---

## 4. `src/ui/screens/profile.jsx`

### 4.1. Вырезать целиком (перенести в буфер, понадобится в §6)

Четыре объявления функций, ПОБУКВЕННО, вместе с комментариями над ними:

- `function ServerListEditor({ … })` — целиком
- `function RelayListEditor({ … })` — целиком
- `function SelfHostedSection({ … })` — целиком
- `function RelayBlossomSection({ … })` — целиком

Они уезжают в `settings.jsx` без единого изменения тела. Разметку внутри
них **не переделывай** — она уже опирается на `.srv__item`/`.srv__url`/
`.badge-on` и в макете выглядит правильно; всё, что ей было нужно, —
фон панели (§5).

### 4.2. Удалить

- секцию-заглушку «Файлы»: `<section … aria-labelledby="profile-files-heading">`
  с `<div class="files-empty">{t("profile.filesComingSoon")}</div>` —
  раздел «Хранилище» есть отдельным пунктом меню, заглушка ничего не даёт;
- вызовы `<RelayBlossomSection … />` и `<SelfHostedSection … />` из `return`;
- ставший неиспользуемым импорт `import IconPlus`/`IconTrash`, **только
  если** после выноса секций они действительно больше нигде не нужны —
  проверь grep'ом по файлу, не «на глаз».

### 4.3. Почистить импорты

Убрать из `profile.jsx` то, что уехало вместе с секциями (проверь каждое
grep'ом по файлу, прежде чем удалять):
`addRelayUrl`, `removeRelayUrl`, `setRelayRole`, `addBlossomUrl`,
`removeBlossomUrl`, `setActiveBlossomUrl`, `pairSelfHostedServer`,
`unpairSelfHostedServer`, `SelfHostedFingerprintMismatchError`,
`decodePairingCode`, `fetchAgentStatus`, `BUILD_DEFAULT_BLOSSOM_SERVERS`,
`reconnectWithNewSettings`, `BLOSSOM_URL`.

`loadUiSettings` и `ensureConnected` проверь отдельно — они могут
использоваться и в самом `Profile()`.

Добавить:

```jsx
import DeleteAccountPanel from "../components/delete-account-panel.jsx";
import IconEye from "../icons/eye.jsx";
import IconTrash from "../icons/trash.jsx";
import { privKeySig } from "../signals/auth.js"; // если ещё не импортирован
```

`src/ui/icons/eye.jsx` — новый файл:

```jsx
// Глаз — раздел видимости в "Знакомствах".
export default function IconEye(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M7.5 3C4.5 3 2.1 4.9 1.1 7.3a.5.5 0 0 0 0 .4C2.1 10.1 4.5 12 7.5 12s5.4-1.9 6.4-4.3a.5.5 0 0 0 0-.4C12.9 4.9 10.5 3 7.5 3zm0 1c2.4 0 4.4 1.5 5.4 3.5-1 2-3 3.5-5.4 3.5S3.1 9.5 2.1 7.5C3.1 5.5 5.1 4 7.5 4zm0 1.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"
				fill="currentColor"
			/>
		</svg>
	);
}
```

### 4.4. `VisibilitySection` — заменить только `return`

Тело функции (состояние, `persist`, `handleVisibleToggle`,
`toggleChannelId`, `useEffect`) — **без изменений**. Заменить возвращаемую
разметку на:

```jsx
	return (
		<section class="panel stack" style={{ "--gap": "var(--space-m)" }}>
			<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
				<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
					<IconEye />
					{t("profile.visibilityTitle")}
				</h2>
				<p class="panel__hint">{t("profile.visibilityHint")}</p>
			</div>

			{error && (
				<p role="alert" class="callout callout--bad">
					{error}
				</p>
			)}

			<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", alignItems: "center" }}>
				<span class="set-row__text">{t("discovery.showMeToggle")}</span>
				<input type="checkbox" class="set-row__switch" checked={settings.visible} onChange={(e) => handleVisibleToggle(e.currentTarget.checked)} />
			</label>

			{/* Вложенность больше НЕ передаётся отступом слева (был инлайновый
			    marginInlineStart — margin на компоненте, REGLAMENT.md §3 п.1).
			    Зависимые настройки просто идут следом: включённый верхний
			    переключатель и так их показывает, а выключенный — скрывает. */}
			{settings.visible && (
				<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
					<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", alignItems: "center" }}>
						<span class="set-row__text">{t("discovery.showChannelsToggle")}</span>
						<input
							type="checkbox"
							class="set-row__switch"
							checked={settings.showChannels}
							onChange={(e) => setSettings({ ...settings, showChannels: e.currentTarget.checked })}
						/>
					</label>

					{settings.showChannels && (
						<fieldset class="stack" style={{ "--gap": "var(--space-2xs)", border: "none", padding: 0 }}>
							<legend class="sect-title">{t("discovery.whichChannelsLegend")}</legend>
							{ownedChannels.length === 0 ? (
								<p class="panel__hint">{t("discovery.noOwnChannels")}</p>
							) : (
								ownedChannels.map((c) => (
									<label key={c.id} class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", alignItems: "center" }}>
										<span class="set-row__text">{c.name}</span>
										<input
											id={`${instanceId}-ch-${c.id}`}
											type="checkbox"
											class="set-row__switch"
											checked={settings.channelIds.includes(c.id)}
											onChange={() => toggleChannelId(c.id)}
										/>
									</label>
								))
							)}
						</fieldset>
					)}

					<div class="row" style={{ "--gap": "var(--space-s)" }}>
						<button type="button" class="rigid" onClick={() => persist(settings)}>
							{t("common.save")}
						</button>
					</div>
				</div>
			)}
		</section>
	);
```

Обрати внимание: кнопка внизу была подписана строковым литералом `OK` —
единственное непереведённое место в файле. Заменено на существующий ключ
`common.save`. Проверь, что он есть; если нет — используй `common.confirm`.

### 4.5. `Profile()` — заменить `return`

Тело функции (всё состояние, `handleCopyNpub`, `handleAvatarChange`,
`handleAvatarFromStorage`, `handleBioSubmit`, все `useEffect`, ранний
`if (loading)`) — **без изменений**. Заменить возвращаемую разметку на:

```jsx
	return (
		<Screen title={login || t("profile.noNameFallback")}>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
				<section class="panel stack" style={{ "--gap": "var(--space-m)" }}>
					<div class="ident row" style={{ "--gap": "var(--space-m)" }}>
						{/* Фото и две кнопки под ним были парой, делающей одно и то
						    же, но в двух разных формах: "Заменить" — <label> с
						    .profile-avatar-replace-btn (--radius-full), "Из
						    хранилища" — обычная кнопка (--radius). Теперь обе
						    внутри одной накладки на нижней кромке фотографии.
						    .layer — композиционный класс: обе дочки в одной
						    ячейке грида, накладка прижата вниз через .self-end. */}
						<div class="ident__photo">
							<div class="ava layer">
								{/* Приоритет avatar || avatarUrl НЕ менять — см. комментарий
								    этапа 74 в истории файла: корректность обеспечивает
								    инвалидация в hydrateOwnProfile, а не порядок здесь. */}
								{avatar || avatarUrl ? (
									<img src={avatar || avatarUrl} alt="" class="profile-avatar-square" />
								) : (
									<div
										role="img"
										aria-label={t("profile.avatarNotSetAria")}
										class="profile-avatar-square profile-avatar-square-fallback row"
										style={{ alignItems: "center", justifyContent: "center" }}
									>
										{initial}
									</div>
								)}
								<div class="ava__actions over self-end bar" style={{ "--gap": "var(--space-3xs)" }}>
									<label for="profile-avatar-input" class="ava__btn bar">
										{t("profile.replaceAvatarLabel")}
									</label>
									<input id="profile-avatar-input" class="visually-hidden" type="file" accept="image/*" onChange={handleAvatarChange} />
									<button type="button" class="ava__btn bar" onClick={() => setAvatarPickerOpen(true)}>
										{t("profile.chooseFromStorageButton")}
									</button>
								</div>
							</div>
							{avatarError && (
								<p role="alert" class="callout callout--bad">
									{avatarError}
								</p>
							)}
						</div>

						{avatarPickerOpen && (
							<FilePicker predicate={(node) => node.kind === "file"} multiple={false} onSelect={handleAvatarFromStorage} onCancel={() => setAvatarPickerOpen(false)} />
						)}

						<form class="ident__body stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleBioSubmit}>
							<h2 class="ident__name">{login || t("profile.noNameFallback")}</h2>

							<div class="keybox row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
								<code>{npubEncode(id)}</code>
								<button type="button" class="icon-btn rigid" onClick={handleCopyNpub} aria-label={t("profile.copyKeyAria")}>
									<IconCopy />
								</button>
							</div>
							{copyStatus && (
								<p role="status" class="panel__hint">
									{copyStatus}
								</p>
							)}
							<p class="panel__hint">{t("profile.identifierHint")}</p>

							<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
								<label for="profile-bio">{t("profile.bioLabel")}</label>
								<textarea id="profile-bio" rows="4" value={bio} onInput={(e) => setBio(e.currentTarget.value)} />
							</div>

							<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
								<button type="submit" class="rigid" disabled={!bioIsDirty}>
									{t("common.save")}
								</button>
								{bioStatus && (
									<span role="status" class="panel__hint">
										{bioStatus}
									</span>
								)}
								{publishStatus && (
									<span role="status" class="panel__hint">
										{publishStatus}
									</span>
								)}
							</div>
						</form>
					</div>
				</section>

				<VisibilitySection ownerPubkey={id} privKey={privKeySig.value} dbKey={dbKeySig.value} />

				{/* Переехало из "Настроек": удаление относится к тому, КТО ты, а
				    не к тому, как ведёт себя приложение. */}
				<section class="panel panel--danger stack" style={{ "--gap": "var(--space-m)" }}>
					<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
						<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
							<IconTrash />
							{t("settings.dangerZoneTitle")}
						</h2>
					</div>
					<DeleteAccountPanel ownerPubkey={id} login={login} privKey={privKeySig.value} dbKey={dbKeySig.value} />
				</section>
			</div>
		</Screen>
	);
```

Ключ `settings.dangerZoneTitle` намеренно НЕ переименовывается в
`profile.*`: переименование ключа — это правка двенадцати файлов ради
косметики пространства имён. То же касается `profile.relayServersTitle`,
`profile.blossomServersTitle` и всего узла `profile.selfHosted.*`, которые
уезжают в «Настройки», — **имена ключей оставить как есть.**

---

## 5. `src/styles/custom.css`

### 5.1. Три точечные правки в существующих правилах

**(а)** Найди `.sect-title { … }` и убери из него `margin-block: 0 var(--space-s);`
Причина в комментарии нового блока (§5.2, п.1) — не дублируй её здесь.

**(б)** Найди `.keybox { … }` и замени на:

```css
.keybox {
	/* .row (раскладка) уже в JSX. */
	background-color: var(--surface-raised);
	border-radius: var(--radius);
	padding: var(--space-2xs) var(--space-2xs) var(--space-2xs) var(--space-s);
}
```

(убрана строка `border: var(--border-width) solid var(--border);` —
объяснение в §5.2, п. 8a).

**(в)** Удали правила `.profile-avatar-replace-btn` и
`.profile-avatar-replace-btn:hover` — класс больше не используется
(проверь `grep -rn "profile-avatar-replace-btn" src/`, должно быть пусто).

### 5.2. Новый блок

Добавь в конец `custom.css` целиком, дословно. Если задача по «Журналу»
уже выполнена, **раздел 0 ниже там уже есть** — тогда пропусти его и
вставь начиная с раздела 1; дублировать правила не надо.

```css
/* ================================================================== *
 *  СЛОВАРЬ, добавляемый парой "Профиль/Настройки". Всё это — новые    *
 *  классы проектного слоя; раскладку по-прежнему держат               *
 *  композиционные (.stack/.row/.bar/.grow/.rigid), здесь только вид   *
 *  и параметры гибкости конкретных детей.                             *
 * ================================================================== */

/* ---- 0. Одна линия под "головой" экрана --------------------------- *
 * Правка не этих экранов, а всего приложения: .section-header рисует
 * границу снизу, .slices-zone — свою, а .tabs — ещё одну. Три линии
 * подряд, и ряд вкладок между ними как в тисках. Линия должна быть
 * одна, под всей головой, и подчёркивание активной вкладки обязано
 * лечь ровно на неё. Затронуты все экраны со slices-zone.             */
.section-header:has(+ .slices-zone) {
	border-block-end: none;
}
.section-header {
	container-type: inline-size;
}
.slices-zone:has(.tabs) {
	padding-block-start: var(--space-2xs);
	padding-block-end: 0;
}
.slices-zone .tabs {
	margin-block: 0;
	border-block-end: none;
}
.slices-zone .tab {
	padding-block: var(--space-xs);
}

/* ---- 1. Панель раздела ------------------------------------------- *
 * Настройки были плоским свитком из <section class="stack"> без
 * единой границы: девять разделов подряд, ничем не разделённых, —
 * отсюда ощущение "на скорую руку". Панель даёт разделу физические
 * границы, и отступ между разделами перестаёт быть единственным
 * средством группировки.                                              */
.panel {
	background-color: var(--surface);
	border: var(--border-width) solid var(--border);
	border-radius: var(--radius-lg);
	padding: var(--space-m);
}
.panel__title {
	font-family: var(--font-display);
	font-size: var(--step-1);
	letter-spacing: var(--heading-letter-spacing);
	margin-block: 0;
}
.panel__title > .icon {
	color: var(--muted);
	flex: none;
}
.panel__hint {
	color: var(--muted);
	font-size: var(--step--1);
	margin-block: 0;
}

/* Поля и селекты на фоне панели: у обоих был var(--surface), и контрол
   растворялся в подложке — от него оставалась одна рамка. Панель
   поднимает свои контролы на тон выше себя. Чекбоксы/радио/ползунок
   исключены: им appearance:auto вернули нативную отрисовку, красить их
   фон нечем и незачем. */
.panel :is(input, select, textarea):not([type="checkbox"], [type="radio"], [type="range"], [type="color"]) {
	background-color: var(--surface-raised);
}

/* НАЙДЕННЫЙ ДЕФЕКТ: .sect-title несёт собственный margin-block-end,
   и при этом всегда лежит внутри .stack со своим --gap. Отступ под
   заголовком складывался из двух источников — отсюда "невозможно
   смотреть на отступы". Отступ задаёт только раскладка. */
.sect-title {
	margin-block: 0;
}

/* ---- 2. Строка настройки ------------------------------------------ *
 * Повторяющаяся молекула "подпись слева — контрол справа": в проекте
 * она написана руками 46 раз через инлайновый
 * justify-content:space-between. Здесь она названа, и вместе с именем
 * получает поведение при нехватке ширины: подпись имеет базис 16rem,
 * поэтому в узком контейнере контрол переносится ПОД неё сам, без
 * единого запроса к ширине.                                           */
.set-row__text {
	flex: 1 1 16rem;
	min-inline-size: 0;
}
.set-row__hint {
	color: var(--muted);
	font-size: var(--step--2);
}

/* НАЙДЕННЫЙ ДЕФЕКТ: в minimal.css (слой elements) у select стоит
   width:100%. Для формы это верно, но в строке настройки давало
   селект во всю ширину экрана ради выбора из четырёх слов. Правило
   там НЕ трогаем — переопределяем точечно на контроле строки. */
.set-row__control {
	flex: 0 1 auto;
	inline-size: auto;
	min-inline-size: 11rem;
}
.set-row__switch {
	flex: none;
	inline-size: 1.15rem;
	block-size: 1.15rem;
}

/* Разделители между строками — вместо того чтобы разносить их
   отступами всё дальше друг от друга. */
.set-list > * + * {
	border-block-start: var(--border-width) solid var(--border);
	padding-block-start: var(--space-s);
}

/* ---- 3. Образцы цвета --------------------------------------------- *
 * Было: пятнадцать <button>, то есть пятнадцать заливок акцентным
 * цветом, внутри каждой — кружок нужного оттенка и подпись. Цвет,
 * который выбираешь, конкурировал с цветом кнопки, на которой он
 * нарисован. Стало: сам образец И ЕСТЬ кнопка. Подписи убраны —
 * "олива" и "бирюза" не сообщают ничего сверх видимого цвета.        */
.swatch {
	inline-size: 2.25rem;
	block-size: 2.25rem;
	padding: 3px;
	border: 2px solid transparent;
	border-radius: var(--radius-full);
	background-color: transparent;
	cursor: pointer;
}
.swatch:hover {
	background-color: transparent;
	border-color: var(--border);
}
.swatch:active {
	transform: none;
}
.swatch > span {
	display: block;
	inline-size: 100%;
	block-size: 100%;
	border-radius: inherit;
}
.swatch[aria-pressed="true"] {
	border-color: var(--fg);
}

/* ---- 4. Сегмент из двух-трёх взаимоисключающих кнопок -------------- */
.seg .slice {
	border-radius: 0;
}
.seg .slice:first-child {
	border-start-start-radius: var(--radius-full);
	border-end-start-radius: var(--radius-full);
}
.seg .slice:last-child {
	border-start-end-radius: var(--radius-full);
	border-end-end-radius: var(--radius-full);
}
.seg .slice + .slice {
	margin-inline-start: calc(var(--border-width) * -1);
}
/* Кнопки состыкованы отрицательным отступом, поэтому левая граница
   соседа ложится поверх правой границы активной. Активную поднимаем
   над соседями — иначе у неё "пропадает" рамка с одной стороны. */
.seg .slice--on {
	position: relative;
	z-index: 1;
}
.slice--on {
	color: var(--fg);
	border-color: var(--accent);
	background-color: color-mix(in oklch, var(--accent), transparent 86%);
}

/* ---- 5. Врезка-предупреждение ------------------------------------- *
 * Было: <p> с инлайновыми background/padding/borderRadius в трёх
 * местах, каждый раз заново.                                          */
.callout {
	padding: var(--space-s);
	border-radius: var(--radius);
	border: var(--border-width) solid var(--border);
	background-color: var(--surface-raised);
	font-size: var(--step--1);
}
.callout--warn {
	border-color: color-mix(in oklch, var(--warn, var(--accent)), transparent 55%);
}
.callout--bad {
	border-color: color-mix(in oklch, var(--bad), transparent 55%);
	color: var(--bad);
}

/* ---- 6. Опасная зона ---------------------------------------------- */
.panel--danger {
	border-color: color-mix(in oklch, var(--bad), transparent 55%);
	background-color: color-mix(in oklch, var(--bad), transparent 94%);
}
.panel--danger .panel__title,
.panel--danger .panel__title > .icon {
	color: var(--bad);
}

/* ---- 7. Раскрывающиеся исключения --------------------------------- *
 * Таблицы "уровень уведомления на каждый контакт / канал" висели на
 * экране развёрнутыми всегда: у человека с сорока контактами это
 * восемьдесят строк между двумя обычными настройками. Теперь это
 * <details> со счётчиком, свёрнутый по умолчанию, и внутри — те же
 * .set-row, а не <table>: четыре колонки селектов на телефон не
 * помещаются в принципе.                                              */
.exceptions {
	border: var(--border-width) solid var(--border);
	border-radius: var(--radius);
	background-color: var(--surface-raised);
}
.exceptions > summary {
	cursor: pointer;
	color: var(--muted);
	font-size: var(--step--1);
	list-style: none;
	padding: var(--space-xs) var(--space-s);
	border-radius: inherit;
}
.exceptions > summary:hover {
	color: var(--fg);
}
.exceptions[open] > summary {
	border-block-end: var(--border-width) solid var(--border);
	border-end-start-radius: 0;
	border-end-end-radius: 0;
}
.exceptions > summary::-webkit-details-marker {
	display: none;
}
/* Отступ внутренностей задаёт обёртка (padding), а не сами строки —
   раньше он был инлайновым padding-block-start на первом же элементе,
   отчего слева и справа содержимое упиралось в границу. */
.exceptions__body {
	padding: var(--space-s);
}
.exceptions > summary > .icon {
	transition: rotate var(--transition-speed) var(--transition-ease);
}
.exceptions[open] > summary > .icon {
	rotate: 180deg;
}

/* ---- 8. Личность в шапке профиля ---------------------------------- */
.ident {
	--gap: var(--space-m);
}
.ident__photo {
	flex: 0 0 auto;
}
.ident__body {
	flex: 1 1 18rem;
	min-inline-size: 0;
}
/* ---- 8a. Аватар с накладной панелью действий ---------------------- *
 * Было: розовая пилюля "Заменить" (label, --radius-full) и обычная
 * кнопка "Из хранилища" (--radius) в один ряд — разные формы у пары,
 * которая делает одно и то же. Стало: обе внутри одной накладки на
 * нижней кромке фотографии, одинаковые. .layer — композиционный класс
 * (обе дочки в одной ячейке грида), накладка прижата .self-end.       */
.ava {
	inline-size: 12rem;
	border-radius: var(--radius);
	overflow: hidden;
}
.ava__actions {
	padding: var(--space-3xs);
	background-color: color-mix(in oklch, var(--bg), transparent 20%);
	backdrop-filter: blur(8px);
	justify-content: center;
}
.ava__btn {
	flex: 1 1 auto;
	align-items: center;
	justify-content: center;
	padding: var(--space-3xs) var(--space-2xs);
	border: none;
	border-radius: var(--radius-sm);
	background-color: transparent;
	color: var(--fg);
	font-size: var(--step--2);
	font-weight: var(--weight-bold);
	line-height: 1.2;
	cursor: pointer;
}
.ava__btn:hover {
	background-color: var(--surface-raised);
}
.ava__btn:active {
	transform: none;
}

/* НАЙДЕННЫЙ ДЕФЕКТ: у .keybox рамка И заливка var(--surface) — на
   панели того же тона от блока оставалась только рамка, а сам он не
   читался как поле. Рамка убрана, различие несёт тон. */
.keybox {
	border: none;
	background-color: var(--surface-raised);
}

.ident__name {
	font-family: var(--font-display);
	font-size: var(--step-2);
	letter-spacing: var(--heading-letter-spacing);
	margin-block: 0;
}

/* ---- 9. Оглавление сбоку (вариант А) ------------------------------ */
.set-nav {
	flex: 0 0 13rem;
	align-self: start;
	position: sticky;
	inset-block-start: 0;
	padding-block: var(--space-2xs);
}
.set-nav a {
	display: block;
	padding: var(--space-2xs) var(--space-s);
	border-radius: var(--radius);
	color: var(--muted);
	text-decoration: none;
}
.set-nav a:hover {
	background-color: var(--surface);
	color: var(--fg);
}
.set-nav a[aria-current="true"] {
	background-color: var(--surface);
	color: var(--fg);
	font-weight: var(--weight-bold);
}
@container (max-width: 46em) {
	.set-nav {
		display: none;
	}
}
```

---

## 6. `src/ui/screens/settings.jsx`

### 6.1. Принять переехавшее

Вставь в файл четыре функции из §4.1 **побуквенно как есть**:
`ServerListEditor`, `RelayListEditor`, `SelfHostedSection`,
`RelayBlossomSection`. Расположи их после `OverrideSelect` и до
`export default function Settings()`.

Добавь импорты, которые им нужны (перенеси из `profile.jsx`):

```jsx
import {
	loadUiSettings,
	saveUiSettings,
	addRelayUrl,
	removeRelayUrl,
	setRelayRole,
	addBlossomUrl,
	removeBlossomUrl,
	setActiveBlossomUrl,
	pairSelfHostedServer,
	unpairSelfHostedServer,
	SelfHostedFingerprintMismatchError,
} from "../../domain/settings/ui-settings.js";
import { publish, reconnectWithNewSettings } from "../signals/transport.js";
import { decodePairingCode, fetchAgentStatus } from "../../domain/selfhost/pairing.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import IconTrash from "../icons/trash.jsx";
import IconPlus from "../icons/plus.jsx";
import IconGear from "../icons/gear.jsx";
import IconBell from "../icons/bell.jsx";
import IconServer from "../icons/server.jsx";
import IconPower from "../icons/power.jsx";
import { applyThemeMode } from "../theme/theme-mode.js";
```

`loadUiSettings`/`saveUiSettings` уже импортированы — не дублируй, просто
дополни существующий список. Константу `const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];`
перенеси тоже, если её использует какая-то из переехавших функций (проверь
grep'ом; если нет — не переноси и не импортируй `BUILD_DEFAULT_BLOSSOM_SERVERS`).

### 6.2. Удалить

- `import MnemonicReveal` и всю секцию «Секретная фраза» с
  `<MnemonicReveal … />` — уехала в `security.jsx`;
- `import DeleteAccountPanel` и всю секцию «Опасная зона» с
  `<DeleteAccountPanel … />` — уехала в `profile.jsx`;
- состояние `hasMnemonic`, `setHasMnemonic` и вызов `listAccounts()` в
  `useEffect` — они были нужны только `MnemonicReveal`. Импорт
  `listAccounts` тоже убрать.

### 6.3. Четыре новые иконки

Создать по образцу §3.1 (тот же viewBox, `fill="currentColor"`,
`class="icon"`, `width/height="1em"`, `aria-hidden`):

| Файл | `d` |
|---|---|
| `src/ui/icons/gear.jsx` | `M7.07 1a.5.5 0 0 0-.49.4l-.22 1.1a5.5 5.5 0 0 0-1.02.6l-1.06-.37a.5.5 0 0 0-.6.23l-.93 1.6a.5.5 0 0 0 .11.63l.85.72a5.6 5.6 0 0 0 0 1.18l-.85.72a.5.5 0 0 0-.11.63l.93 1.6a.5.5 0 0 0 .6.23l1.06-.37c.32.24.66.44 1.02.6l.22 1.1a.5.5 0 0 0 .49.4h1.86a.5.5 0 0 0 .49-.4l.22-1.1c.36-.16.7-.36 1.02-.6l1.06.37a.5.5 0 0 0 .6-.23l.93-1.6a.5.5 0 0 0-.11-.63l-.85-.72a5.6 5.6 0 0 0 0-1.18l.85-.72a.5.5 0 0 0 .11-.63l-.93-1.6a.5.5 0 0 0-.6-.23l-1.06.37a5.5 5.5 0 0 0-1.02-.6l-.22-1.1a.5.5 0 0 0-.49-.4H7.07zM7.5 5.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4z` |
| `src/ui/icons/bell.jsx` | `M7.5 1a3.5 3.5 0 0 0-3.5 3.5v2.2c0 .5-.2.98-.55 1.33l-.6.6A.75.75 0 0 0 3.38 10h8.24a.75.75 0 0 0 .53-1.28l-.6-.6A1.88 1.88 0 0 1 11 6.79V4.5A3.5 3.5 0 0 0 7.5 1zM6 11a1.5 1.5 0 0 0 3 0H6z` |
| `src/ui/icons/server.jsx` | `M2 3.5A1.5 1.5 0 0 1 3.5 2h8A1.5 1.5 0 0 1 13 3.5v2A1.5 1.5 0 0 1 11.5 7h-8A1.5 1.5 0 0 1 2 5.5v-2zm1.5-.5a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-2a.5.5 0 0 0-.5-.5h-8zM2 9.5A1.5 1.5 0 0 1 3.5 8h8A1.5 1.5 0 0 1 13 9.5v2a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 11.5v-2zm1.5-.5a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-2a.5.5 0 0 0-.5-.5h-8zM4.5 4.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0zm0 6a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0z` |
| `src/ui/icons/power.jsx` | `M7.5 1a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0v-5a.5.5 0 0 1 .5-.5zM4.4 3.2a.5.5 0 0 1 .1.7 4.5 4.5 0 1 0 6 0 .5.5 0 1 1 .6-.8 5.5 5.5 0 1 1-7.2 0 .5.5 0 0 1 .5.1z` |

Иконка `chevron-down` в проекте уже есть (`src/ui/icons/chevron-down.jsx`).

### 6.4. Новое состояние и обработчик темы

В `Settings()`, рядом с существующим состоянием, добавь:

```jsx
	const [tab, setTab] = useState("view");
```

и обработчик рядом с `handleScaleChange`:

```jsx
	// Тема раньше жила ТОЛЬКО в меню учётной записи и переключалась
	// бинарно (toggleThemeMode). В "Настройках" её не было вовсе, хотя
	// это ровно такой же параметр вида, как масштаб и палитра. Здесь —
	// три положения, включая "как в системе" (themeMode: null), которого
	// бинарный тумблер выразить не может. Кнопка в меню остаётся: она
	// переключает быстро, этот сегмент — точно.
	function handleThemeChange(mode) {
		applyThemeMode(mode); // мгновенный отклик, как applyCustomPalette/applyUiScale
		persist({ ...settings, themeMode: mode });
	}
```

### 6.5. Вспомогательный компонент раздела

Добавь перед `export default function Settings()`:

```jsx
// Панель раздела. "Настройки" были плоским свитком из девяти <section
// class="stack"> без единой границы, и заголовки в них — <h2 style={{
// font: "inherit" }}>, то есть элементный слой заголовка выжжен, а обратно
// возвращён только жир. Девять разделов выглядели одинаково; это и было
// главной причиной ощущения "на скорую руку", а не отступы.
function Panel({ title, hint, icon: Icon, danger, children }) {
	return (
		<section class={`panel stack${danger ? " panel--danger" : ""}`} style={{ "--gap": "var(--space-m)" }}>
			{title && (
				<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
					<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
						{Icon && <Icon />}
						{title}
					</h2>
					{hint && <p class="panel__hint">{hint}</p>}
				</div>
			)}
			{children}
		</section>
	);
}

// Строка настройки: подпись слева, контрол справа. В проекте эта молекула
// была написана руками 46 раз через инлайновый justify-content:
// space-between. Здесь она названа — и вместе с именем получает поведение
// при нехватке ширины: у .set-row__text базис 16rem, поэтому в узком
// контейнере контрол переносится ПОД подпись сам, без запросов к ширине.
function SetRow({ label, hint, children }) {
	return (
		<div class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", alignItems: "center" }}>
			<div class="set-row__text stack" style={{ "--gap": "2px" }}>
				<span>{label}</span>
				{hint && <span class="set-row__hint">{hint}</span>}
			</div>
			{children}
		</div>
	);
}

// Свёрнутый блок с исключениями. Таблицы "уровень на каждый контакт" и
// "на каждый канал" висели на экране развёрнутыми ВСЕГДА: у человека с
// сорока контактами это восемьдесят строк между двумя обычными
// настройками, а четыре колонки селектов на телефон не помещаются в
// принципе. Внутри теперь те же SetRow, а не <table>.
function Disclosure({ summary, children }) {
	return (
		<details class="exceptions">
			<summary class="bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
				<IconChevronDown />
				{summary}
			</summary>
			<div class="exceptions__body stack" style={{ "--gap": "var(--space-s)" }}>
				{children}
			</div>
		</details>
	);
}
```

(добавь `import IconChevronDown from "../icons/chevron-down.jsx";`)

### 6.6. `PaletteSection` — заменить `return`

Состояние `showCustomize`/`instanceId` — без изменений. Разметка:

```jsx
	return (
		<div class="stack" style={{ "--gap": "var(--space-m)" }}>
			{/* Было: пятнадцать <button>, то есть пятнадцать заливок акцентным
			    цветом, и внутри каждой кружок нужного оттенка плюс подпись.
			    Цвет, который выбираешь, конкурировал с цветом кнопки, на
			    которой он нарисован. Теперь образец САМ является кнопкой;
			    подписи убраны — "олива" и "бирюза" не сообщают ничего сверх
			    видимого цвета, а aria-label несёт то же для screen reader'а. */}
			<div class="swatch-grid row" style={{ "--gap": "var(--space-2xs)" }} role="group" aria-label={t("settings.accentColorTitle")}>
				{PALETTE_PRESETS.map((p) => (
					<button
						key={p.id}
						type="button"
						class="swatch"
						aria-pressed={customPalette.accentHue === p.hue}
						aria-label={t(`settings.palettePresets.${p.id}`)}
						title={t(`settings.palettePresets.${p.id}`)}
						onClick={() => onChange({ cNeutral: customPalette.cNeutral, accentHue: p.hue })}
					>
						<span style={{ background: `oklch(0.6 0.17 ${p.hue})` }} />
					</button>
				))}
			</div>

			<Disclosure summary={t("settings.paletteCustomizeButton")}>
				<SetRow label={t("settings.paletteHueLabel")}>
					<input
						id={`${instanceId}-palette-hue`}
						class="set-row__control"
						type="range"
						min="0"
						max="359"
						step="1"
						value={customPalette.accentHue}
						onInput={(e) => onChange({ cNeutral: customPalette.cNeutral, accentHue: Number(e.currentTarget.value) })}
					/>
				</SetRow>
				<SetRow label={t("settings.paletteNeutralChromaLabel")}>
					<input
						id={`${instanceId}-palette-cneutral`}
						class="set-row__control"
						type="range"
						min="0"
						max="0.035"
						step="0.001"
						value={customPalette.cNeutral}
						onInput={(e) => onChange({ cNeutral: Number(e.currentTarget.value), accentHue: customPalette.accentHue })}
					/>
				</SetRow>
			</Disclosure>
		</div>
	);
```

`showCustomize`/`setShowCustomize` становятся неиспользуемыми (раскрытием
теперь управляет нативный `<details>`) — **удали их**, вместе с кнопкой
`aria-expanded`.

### 6.7. `LevelSelect` и `OverrideSelect` — одна правка каждому

Добавь `class="set-row__control"` на `<select>` в обоих компонентах.
Причина: в `minimal.css` (слой `elements`) у `select` стоит `width: 100%`
— для формы это верно, но в строке настройки давало селект во всю ширину
экрана ради выбора из четырёх слов. Правило в `minimal.css` **не трогать**.

### 6.8. `Settings()` — заменить `return`

Ранний `if (!settings)` оставь как есть. Основной `return`:

```jsx
	const n = settings.notifications;

	return (
		<Screen
			title={t("nav.settings")}
			slices={
				<div class="tabs bar" style={{ "--gap": "0" }} role="tablist" aria-label={t("settings.tabsAria")}>
					{["view", "notifications", "network", "session"].map((id) => (
						<button
							key={id}
							type="button"
							class="tab bar"
							style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}
							role="tab"
							aria-selected={tab === id}
							onClick={() => setTab(id)}
						>
							{t(`settings.tabs.${id}`)}
						</button>
					))}
				</div>
			}
		>
			{error && (
				<p role="alert" class="callout callout--bad">
					{error}
				</p>
			)}

			{tab === "view" && (
				<div class="stack" style={{ "--gap": "var(--space-l)" }}>
					<Panel title={t("settings.tabs.view")} hint={t("settings.viewSectionHint")} icon={IconGear}>
						<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
							<SetRow label={t("settings.themeLabel")}>
								<div class="seg bar rigid" style={{ "--gap": "0" }} role="group" aria-label={t("settings.themeLabel")}>
									{[null, "light", "dark"].map((mode) => (
										<button
											key={String(mode)}
											type="button"
											class={`slice bar rigid${settings.themeMode === mode ? " slice--on" : ""}`}
											aria-pressed={settings.themeMode === mode}
											onClick={() => handleThemeChange(mode)}
										>
											{t(`settings.theme.${mode ?? "system"}`)}
										</button>
									))}
								</div>
							</SetRow>

							<SetRow label={t("settings.scaleLabel")}>
								<select id={`${instanceId}-scale`} class="set-row__control" value={settings.uiScale} onChange={(e) => handleScaleChange(e.currentTarget.value)}>
									{SCALE_OPTIONS.map((opt) => (
										<option key={opt.id} value={opt.id}>
											{opt.label}
										</option>
									))}
								</select>
							</SetRow>

							<SetRow label={t("settings.language.label")}>
								<select id={`${instanceId}-language`} class="set-row__control" value={settings.language} onChange={(e) => handleLanguageChange(e.currentTarget.value)}>
									{SUPPORTED_LOCALES.map((locale) => (
										<option key={locale.code} value={locale.code}>
											{locale.nativeName}
										</option>
									))}
								</select>
							</SetRow>
						</div>

						<PaletteSection customPalette={settings.customPalette ?? DEFAULT_CUSTOM_PALETTE} onChange={handlePaletteChange} />
					</Panel>
				</div>
			)}

			{tab === "notifications" && (
				<div class="stack" style={{ "--gap": "var(--space-l)" }}>
					<Panel title={t("settings.notificationsTitle")} icon={IconBell}>
						<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", alignItems: "center" }}>
							<span class="set-row__text">{t("settings.enableNotifications")}</span>
							<input type="checkbox" class="set-row__switch" checked={n.enabled} onChange={(e) => handleToggleEnabled(e.currentTarget.checked)} />
						</label>

						{n.enabled && browserPermission !== "granted" && browserPermission !== "unsupported" && (
							<p role="alert" class="callout callout--warn row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
								<span class="grow">
									{browserPermission === "denied" ? t("settings.browserBlockedNotifications") : t("settings.browserNotAskedNotifications")}
								</span>
								{browserPermission !== "denied" && (
									<button type="button" class="btn--ghost rigid" onClick={handleRequestPermission}>
										{t("settings.requestPermissionButton")}
									</button>
								)}
							</p>
						)}

						<div class="stack" style={{ "--gap": "var(--space-l)", opacity: n.enabled ? 1 : 0.5 }} inert={!n.enabled || undefined}>
							<div class="stack" style={{ "--gap": "var(--space-s)" }}>
								<h3 class="sect-title">{t("nav.contacts")}</h3>
								<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
									<SetRow label={t("settings.newContactRequestsLabel")}>
										<LevelSelect id={`${instanceId}-contacts-newRequests`} value={n.contacts.newRequests} onChange={(l) => handleContactLevel("newRequests", l)} />
									</SetRow>
									<SetRow label={t("settings.requestAcceptedLabel")}>
										<LevelSelect id={`${instanceId}-contacts-accepted`} value={n.contacts.accepted} onChange={(l) => handleContactLevel("accepted", l)} />
									</SetRow>
								</div>
							</div>

							<div class="stack" style={{ "--gap": "var(--space-s)" }}>
								<h3 class="sect-title">{t("nav.messages")}</h3>
								<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
									<SetRow label={t("settings.defaultForNewLabel")}>
										<LevelSelect id={`${instanceId}-messages-default`} value={n.messages.default} onChange={handleMessagesDefault} />
									</SetRow>
								</div>
								{contacts.value.length > 0 && (
									<Disclosure summary={t("settings.contactExceptions", { count: contacts.value.length })}>
										<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
											{contacts.value.map((pubkey) => (
												<SetRow key={pubkey} label={<ContactIdentity pubkey={pubkey} />}>
													<OverrideSelect id={`${instanceId}-messages-${pubkey}`} override={n.messages.overrides[pubkey]} onChange={(l) => handleMessagesOverride(pubkey, l)} />
												</SetRow>
											))}
										</div>
									</Disclosure>
								)}
							</div>

							<div class="stack" style={{ "--gap": "var(--space-s)" }}>
								<h3 class="sect-title">{t("nav.channels")}</h3>
								<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
									<SetRow label={t("settings.postsDefaultLabel")}>
										<LevelSelect id={`${instanceId}-channels-posts`} value={n.channels.posts} onChange={(l) => handleChannelsDefault("posts", l)} />
									</SetRow>
									<SetRow label={t("settings.commentsDefaultLabel")}>
										<LevelSelect id={`${instanceId}-channels-comments`} value={n.channels.comments} onChange={(l) => handleChannelsDefault("comments", l)} />
									</SetRow>
									<SetRow label={t("settings.chatDefaultLabel")}>
										<LevelSelect id={`${instanceId}-channels-chat`} value={n.channels.chat} onChange={(l) => handleChannelsDefault("chat", l)} />
									</SetRow>
								</div>
								{myChannels.length > 0 && (
									<Disclosure summary={t("settings.channelExceptions", { count: myChannels.length })}>
										<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
											{myChannels.map((c) => (
												<div class="stack" style={{ "--gap": "var(--space-2xs)" }} key={c.id}>
													<span class="sect-title">{c.name || t("channels.card.untitled")}</span>
													{["posts", "comments", "chat"].map((sub) => (
														<SetRow key={sub} label={t(`settings.${sub}ColumnHeader`)}>
															<OverrideSelect
																id={`${instanceId}-channels-${c.id}-${sub}`}
																override={n.channels.overrides[c.id]?.[sub]}
																onChange={(l) => handleChannelOverride(c.id, sub, l)}
															/>
														</SetRow>
													))}
												</div>
											))}
										</div>
									</Disclosure>
								)}
							</div>

							<div class="stack" style={{ "--gap": "var(--space-s)" }}>
								<h3 class="sect-title">{t("settings.otherSectionTitle")}</h3>
								<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
									<SetRow label={t("settings.replyReceivedLabel")}>
										<LevelSelect id={`${instanceId}-replies`} value={n.replies} onChange={handleRepliesLevel} />
									</SetRow>
									<SetRow label={t("settings.strangerWantsToWriteLabel")}>
										<LevelSelect id={`${instanceId}-inbox`} value={n.inbox} onChange={handleInboxLevel} />
									</SetRow>
									<SetRow label={t("settings.newReportLabel")}>
										<LevelSelect id={`${instanceId}-moderation-reports`} value={n.moderation.reports} onChange={handleModerationReportsLevel} />
									</SetRow>
								</div>
								<p class="callout callout--warn">{t("settings.moderationAlwaysShownHint")}</p>
							</div>
						</div>
					</Panel>
				</div>
			)}

			{tab === "network" && (
				<div class="stack" style={{ "--gap": "var(--space-l)" }}>
					{/* Переехало из "Профиля": через что вы работаете — это
					    настройка приложения, а не то, кем вы представляетесь. */}
					<Panel title={t("settings.networkTitle")} hint={t("settings.networkHint")} icon={IconServer}>
						<RelayBlossomSection ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} />
						<SelfHostedSection ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} />
					</Panel>
				</div>
			)}

			{tab === "session" && (
				<div class="stack" style={{ "--gap": "var(--space-l)" }}>
					<Panel title={t("settings.sessionSectionTitle")} icon={IconPower}>
						<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
							{/* Иконку в кнопку НЕ добавлять: она уже стоит в заголовке
							    панели, две одинаковые рядом — перебор. Общее правило
							    для этих экранов: иконку несёт заголовок раздела. */}
							<button type="button" class="btn--ghost rigid" onClick={() => lock()}>
								{t("settings.lockNowButton")}
							</button>
							<span class="panel__hint">{t("settings.sessionHint")}</span>
						</div>
					</Panel>
				</div>
			)}
		</Screen>
	);
```

Внутри `RelayListEditor`/`ServerListEditor`/`SelfHostedSection` замени
`<h2 … class="sect-title">` на `<h3 class="sect-title">` — они теперь
вложены в `Panel`, у которой уже есть свой `<h2>`; два `<h2>` подряд ломают
оглавление документа.

---

## 7. Подключение

### 7.1. `src/app.jsx`

```jsx
import Security from "./ui/screens/security.jsx";
```

Рядом с остальными маршрутами:

```jsx
{place.value.kind === "security" && <Security />}
```

В блоке `<AccountCard … />` добавь проп:

```jsx
onOpenSecurity={() => selectNavItem("security")}
```

### 7.2. `src/ui/components/account-card.jsx`

Сейчас там ТРИ пункта, ведущие в одно место: «Настройки», «Секретная
фраза» и «Восстановить доступ» — все три вызывают `onOpenSettings`. Меню
обещает три места и приводит в одно, причём в верх страницы из девяти
разделов.

- В сигнатуру компонента добавь проп `onOpenSecurity`.
- Пункт `sidebarCard.menuMnemonic` — переключи `onClick` на
  `onOpenSecurity`.
- Пункт `sidebarCard.menuRecover` — **удали целиком** (`<li>` и всё
  внутри). Отдельного пункта он больше не заслуживает: экран один, и его
  название теперь покрывает оба смысла.

---

## 8. Локализация

### 8.1. Удалить из всех 12 файлов

`profile.filesComingSoon`, `settings.mnemonicSectionTitle`,
`sidebarCard.menuRecover`, `settings.perContactNotificationsCaption`,
`settings.perChannelNotificationsCaption`, `settings.notificationColumnHeader`,
`settings.repliesSectionTitle`, `settings.strangersSectionTitle`.

Перед удалением каждого — `grep -rn "<ключ>" src/`. Если ключ встречается
где-то ещё, кроме `settings.jsx`/`profile.jsx`, НЕ удаляй его и напиши об
этом в отчёте.

### 8.2. Изменить значение (ключ остаётся)

`sidebarCard.menuMnemonic`: ru — `"Ключ и восстановление"`, en —
`"Key and recovery"`, остальные — перевести.

### 8.3. Добавить во все 12 файлов

`ru.json`, дословно:

```json
"security": {
	"title": "Ключ и восстановление",
	"mnemonicTitle": "Секретная фраза",
	"mnemonicHint": "Единственный способ вернуть доступ, если вы забыли пароль или потеряли устройство.",
	"mnemonicWarning": "Двенадцать слов — это и есть ваша учётная запись. Кто их знает, тот вы. Запишите на бумаге и держите не в этом устройстве.",
	"recoverTitle": "Восстановление доступа",
	"recoverBody": "Восстановление по фразе происходит на экране входа. Нажмите кнопку ниже — приложение выгрузит ключи из памяти и вернётся к входу, там выберите «Дополнительно» и вход по секретной фразе.",
	"recoverButton": "Заблокировать и перейти к восстановлению"
}
```

в узел `settings`:

```json
"tabsAria": "Разделы настроек",
"tabs": {
	"view": "Вид",
	"notifications": "Уведомления",
	"network": "Сеть",
	"session": "Сессия"
},
"viewSectionHint": "Цвет акцента задаёт всю палитру — фон, поверхности и границы следуют за ним.",
"themeLabel": "Тема",
"theme": { "system": "Как в системе", "light": "Светлая", "dark": "Тёмная" },
"otherSectionTitle": "Остальное",
"contactExceptions": "Исключения для отдельных собеседников · {{count}}",
"channelExceptions": "Исключения для отдельных каналов · {{count}}",
"networkTitle": "Сеть",
"networkHint": "Через что работает приложение: откуда приходят события, куда загружаются файлы, к какому своему серверу вы подключены.",
"sessionHint": "Ключи будут выгружены из памяти, потребуется пароль."
```

в узел `profile`:

```json
"visibilityTitle": "Знакомства",
"visibilityHint": "Пока выключено, вас не видит никто, кроме тех, кому вы сами дали ключ."
```

`en.json` — перевести; остальные 10 (`es, de, ja, fr, pt, it, nl, pl, tr,
zh`) — тоже, сохранив ИМЕНА ключей один в один.

`contactExceptions`/`channelExceptions` — **обычные строки с `{{count}}`,
не узлы множественного числа.** Здесь число стоит после разделителя как
счётчик, а не согласуется с существительным, поэтому `tPlural` не нужен.

Тест `tests/i18n.test.js` требует идентичного набора путей ключей во всех
12 файлах — он и поймает, если где-то забыл.

---

## 9. Приёмка

Отчитайся по каждому пункту явным «да»/«нет»:

- [ ] `npm test` — зелёный, включая `i18n.test.js`
- [ ] `npm run build` — проходит, бюджет бандла не превышен
- [ ] `grep -rn "profile-avatar-replace-btn\|files-empty\|filesComingSoon" src/` — пусто
- [ ] `grep -rn "font: \"inherit\"" src/ui/screens/settings.jsx` — пусто
- [ ] `grep -rn "marginInlineStart" src/ui/screens/profile.jsx` — пусто
- [ ] `grep -n "<table" src/ui/screens/settings.jsx` — пусто
- [ ] В `settings.jsx` и `profile.jsx` нет `margin` в инлайн-стилях
- [ ] Ровно один `.scroller` на пути от `.shell` до листа
- [ ] Визуально: под шапкой «Настроек» ОДНА горизонтальная линия, подчёркивание активной вкладки лежит на ней
- [ ] Визуально: селекты и поля внутри панели отличаются тоном от её фона
- [ ] Визуально: у активной кнопки в сегменте темы рамка не пропадает ни с одной стороны
- [ ] Визуально: узкий экран — контрол в строке настройки переносится под подпись, ничего не обрезано
- [ ] Клавиатурой: Tab обходит вкладки и все контролы; `<details>` открывается пробелом; фокус нигде не теряется
- [ ] Меню учётной записи: «Настройки» → настройки, «Ключ и восстановление» → новый экран, пункта «Восстановить доступ» больше нет

---

## 10. Открытые вопросы — НЕ реализовывать

Перечислено, чтобы ты не «дорешал» по своей инициативе:

1. **Смены пароля не существует** в проекте. На экране «Ключ и
   восстановление» её нет и добавлять не надо.
2. **Восстановление по фразе внутри приложения** не реализуется — только
   переход к существующему потоку через `lock()`.
3. **Ключи `profile.relayServersTitle`, `profile.blossomServersTitle`,
   `profile.selfHosted.*`, `settings.dangerZoneTitle`** остаются в своих
   узлах, хотя экраны поменялись местами. Переименование — правка
   двенадцати файлов ради косметики.
4. **`align-items` в инлайн-стилях** сохранены ради единообразия с
   остальным кодом. Системное решение (`--align` в композиционном слое) —
   правка `REGLAMENT.md`, отдельная задача.
5. **Вариант «Сеть отдельным экраном»** (`settings-C.html`) отклонён в
   пользу вкладки. Не возвращать.
