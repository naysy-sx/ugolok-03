# ТЗ: боковая панель (aside) — переделка карточки учётной записи и списков

Эталон: `PROCESS-DOCS/REDESIGN/aside-mockup.html` (положи туда приложенный файл
перед началом работы). Всё, что расходится между этим текстом и эталоном, —
решается в пользу **этого текста**.

---

## 0. Главное правило. Прочитай прежде, чем писать хоть строчку CSS

Прошлый заход по этому же блоку дал «примерно похоже, но не то». Причина не в
невнимательности, а в механике каскада, и она уже описана в шапке
`src/styles/custom.css`:

`minimal.css` целиком лежит в `@layer`, `custom.css` — вне слоёв, поэтому он
побеждает **по каждому свойству отдельно, а не правилом целиком**. Если класс
блока какое-то свойство не объявил, значение молча приходит из
`@layer elements`, написанного под голые теги.

Отсюда рабочее требование, обязательное для всего этого ТЗ:

> **Для каждого элемента, который получает класс, выпиши все свойства, которые
> `@layer elements` задаёт его тегу, и объяви их в правиле явно — даже если
> значение совпадает с наследуемым.**

Особенно это касается `button` (`background-color`, `color`, `border`,
`padding`, `font`), `summary` (`list-style`, `cursor`, `font-weight`),
`details` (`border`, `border-radius`, `padding`), `input`, `ul`, `p`.

Ниже CSS выписан уже с учётом этого. **Не сокращай его**, не выноси «общее»
в короткие правила и не полагайся на наследование. Если кажется, что строка
лишняя — она не лишняя, это защита от протечки.

Второе правило: **никаких новых композиционных классов**. Раскладка — только
существующими `stack` / `bar` / `row` / `grow` / `rigid` / `scroller` /
`truncate` / `layer` из `@layer composition`. Параметры — переменными
(`--gap`, `--lines`), не новыми классами. Это `PROCESS-DOCS/REGLAMENT.md`.

---

## 1. Файлы, которых касается работа

| Файл | Что делаем |
|---|---|
| `src/ui/components/sidebar-profile-card.jsx` | → переименовать в `account-card.jsx`, переписать |
| `src/ui/components/account-avatar.jsx` | три класса размеров → один класс + переменная |
| `src/ui/components/nav-groups.jsx` | отступы строк, отклик на наведение, активная строка |
| `src/ui/components/connection-status.jsx` | молчит, пока всё в порядке |
| `src/ui/components/actions-menu.jsx` | только переименование `menu__pop` |
| `src/ui/screens/contacts.jsx` | только переименование `menu__pop` |
| `src/app.jsx` | импорт и имя компонента карточки |
| `src/styles/custom.css` | основной объём |
| `src/ui/i18n/locales/*.json` | новые ключи (12 файлов) |

---

## 2. Этап 1 — переименование `menu__pop` → `menu-pop`

Механическая правка, делается первой и отдельным коммитом, чтобы не смешаться
с остальным.

* В `custom.css` заменить все `.menu__pop` на `.menu-pop` (включая составные
  селекторы вида `.menu__pop button`, `.menu__pop .danger` и т. п.).
* В `sidebar-profile-card.jsx`, `nav-groups.jsx`, `actions-menu.jsx`,
  `contacts.jsx` заменить `class="menu__pop …"` на `class="menu-pop …"`.
* Класс `.menu-item-hint` переименовать в `.menu-hint` (он принадлежит меню,
  а не карточке; текущее имя — третий стиль именования в одном блоке).
* Больше **ничего** в этом коммите не менять. Внешний вид обязан остаться
  идентичным: проверяется тем, что `grep -r "menu__pop" src/` пуст.

---

## 3. Этап 2 — `AccountAvatar`: один класс, размер переменной

Сейчас: `account-avatar` / `account-avatar-sm` / `account-avatar-large`, плюс
разводящее правило `.app-layout .account-avatar-sm` — оно понадобилось только
потому, что три имени конфликтовали между собой.

Стало: один класс, размер приходит переменной.

**Новые токены** — в `minimal.css`, `@layer tokens`, рядом с остальными:

```css
--avatar-s: 1.75rem;   /* строки списков (.stream-ava) */
--avatar-m: 2.5rem;    /* строки контактов, экран входа */
--avatar-l: 4rem;      /* крупный вариант экрана входа */
--avatar: var(--avatar-m);
```

**`account-avatar.jsx`** — сигнатуру пропсов не меняем (её знают `unlock.jsx`
и остальные), меняем только то, что она порождает:

```jsx
export default function AccountAvatar({ avatar, login, large, small }) {
	const size = large ? "var(--avatar-l)" : small ? "var(--avatar-s)" : "var(--avatar-m)";
	if (avatar) {
		return <img src={avatar} alt="" class="account-avatar" style={{ "--avatar": size }} />;
	}
	return (
		<div
			class="account-avatar account-avatar-fallback row"
			style={{ "--avatar": size, alignItems: "center", justifyContent: "center" }}
			aria-hidden="true"
		>
			{(login || "?").trim().charAt(0).toUpperCase()}
		</div>
	);
}
```

**CSS**: правила `.account-avatar-sm`, `.account-avatar-large` и
`.app-layout .account-avatar-sm` **удалить целиком**, вместо них:

```css
.account-avatar {
	display: block;
	inline-size: var(--avatar);
	block-size: var(--avatar);
	flex: none;
	object-fit: cover;
	border: 0;
	border-radius: var(--radius-sm);
	background-color: var(--surface-raised);
	padding: 0;
	margin: 0;
}
.account-avatar-fallback {
	color: var(--muted);
	font-size: var(--step--1);
	font-weight: var(--weight-bold);
	line-height: 1;
}
```

---

## 4. Этап 3 — карточка учётной записи

### 4.1 Что уходит

* Карточка **перестаёт быть `<details>`** и перестаёт быть одной кликабельной
  целью. Причина: одна большая цель не даёт разместить внутри мелкие
  (копирование ключа), а на выезжающей панели телефона большой триггер
  срабатывает от случайного касания при скролле.
* Классы `idwrap`, `idcard__btn`, `idcard__body`, `idcard__name`,
  `idcard__bio`, `chev`, `sep` — **удалить из разметки и из CSS**. Из них:
  * `.idcard__btn` дублировал `list-style: none` и гашение
    `::-webkit-details-marker`, которые уже есть в `.menu > summary`;
  * `.idcard__body { min-inline-size: 0 }` не делал ничего — сброс ставит
    `min-width: 0` на `*`;
  * `.idcard__name` сводился к `font-weight: bold` — это даёт `<strong>`.
* Пункт меню **«Удалить учётную запись» убрать**. Он остаётся только в
  «Настройках» (`DeleteAccountPanel` там уже есть, `settings.jsx:492`).
* Постоянная строка «Relay: … / Blossom: …» внизу панели — см. этап 5.

### 4.2 Файл `src/ui/components/account-card.jsx`

Переименование файла делать через `git mv`, чтобы история не потерялась.

```jsx
import { useState, useEffect } from "preact/hooks";
import { npubEncode } from "nostr-tools/nip19";
import { currentUser, lock } from "../signals/auth.js";
import { profileActivity } from "../signals/profile.js";
import { connState, synced } from "../signals/transport.js";
import { getProfile } from "../../core/crypto/keystore.js";
import { resolveEffectiveTheme } from "../theme/theme-mode.js";
import { pushToast } from "../signals/toasts.js";
import { relayStatusInfo } from "./connection-status.jsx";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import AccountAvatar from "./account-avatar.jsx";
import IconGear from "../icons/gear.jsx";
import IconPerson from "../icons/person.jsx";
import IconSun from "../icons/sun.jsx";
import IconMoon from "../icons/moon.jsx";
import IconLockClosed from "../icons/lock-closed.jsx";
import IconFolder from "../icons/folder.jsx";
import IconHelpCircle from "../icons/help-circle.jsx";
import IconActivityLog from "../icons/activity-log.jsx";
import IconExit from "../icons/exit.jsx";
import IconCopy from "../icons/copy.jsx";        // если такой иконки нет — завести
import IconDotsHorizontal from "../icons/dots-horizontal.jsx"; // то же самое
import { t } from "../signals/i18n.js";

export default function AccountCard({ onEditProfile, onOpenStorage, onOpenSettings, onOpenHelp, onOpenDiagnostics, themeMode, onToggleTheme }) {
	const id = currentUser.value.id;
	const login = currentUser.value.login;
	const [avatar, setAvatar] = useState("");
	const [avatarUrl, setAvatarUrl] = useState("");
	const [bio, setBio] = useState("");
	const { ref: menuRef, handleMenuClick } = useDetailsMenu();

	useEffect(() => {
		let cancelled = false;
		getProfile(id).then((profile) => {
			if (cancelled) return;
			setAvatar(profile.avatar);
			setAvatarUrl(profile.avatarUrl);
			setBio(profile.bio);
		});
		return () => { cancelled = true; };
	}, [id, profileActivity.value]);

	// Тишина означает норму: строка предупреждения существует в DOM только
	// когда состояние НЕ ok. Постоянная «3 реле на связи» через неделю
	// становится невидимой ровно как шум — появление текста само по себе
	// должно нести сигнал.
	const relay = relayStatusInfo(connState.value, synced.value);
	const degraded = relay.tone !== "ok";

	async function handleCopyKey() {
		try {
			await navigator.clipboard.writeText(npubEncode(id));
			pushToast({ title: t("account.keyCopied") });
		} catch {
			pushToast({ title: t("account.keyCopyFailed") });
		}
	}

	return (
		<div class="account stack" style={{ "--gap": "var(--space-3xs)" }}>
			{/* Портрет — кнопка ровно с одной ролью: открыть «Профиль».
			    Вешать сюда ещё и меню нельзя: человек, пришедший посмотреть
			    своё фото, будет каждый раз получать список с «Выйти». */}
			<button type="button" class="account-portrait" onClick={onEditProfile} aria-label={t("account.portraitAria")}>
				<AccountAvatar avatar={avatar || avatarUrl} login={login || id} />
				<span class={`account-dot${degraded ? " account-dot--warn" : ""}`} aria-hidden="true" />
			</button>

			<div class="account-line bar" style={{ "--gap": "var(--space-3xs)" }}>
				<strong class="account-name grow truncate" title={login || id}>
					{login || id.slice(0, 16) + "…"}
				</strong>

				<button type="button" class="icon-btn" onClick={handleCopyKey} aria-label={t("account.copyKeyAria")} title={t("account.copyKeyAria")}>
					<IconCopy />
				</button>

				<details class="menu" ref={menuRef} onClick={handleMenuClick}>
					<summary class="icon-btn" aria-label={t("account.menuAria")}>
						<IconDotsHorizontal />
					</summary>
					<div class="menu-pop stack" style={{ "--gap": "0" }}>
						<ul class="stack" style={{ "--gap": "1px" }}>
							<li><button type="button" onClick={onEditProfile}><IconPerson /> {t("sidebarCard.menuProfile")}</button></li>
							<li><button type="button" onClick={onOpenSettings}><IconGear /> {t("sidebarCard.menuSettings")}</button></li>
							<li><button type="button" onClick={onToggleTheme}>
								{resolveEffectiveTheme(themeMode) === "dark" ? <IconSun /> : <IconMoon />} {t("sidebarCard.menuTheme")}
								<span class="menu-hint">{resolveEffectiveTheme(themeMode) === "dark" ? t("themeStatus.dark") : t("themeStatus.light")}</span>
							</button></li>
						</ul>
						<ul class="stack" style={{ "--gap": "1px" }}>
							<li><button type="button" onClick={onOpenSettings}><IconLockClosed /> {t("sidebarCard.menuMnemonic")}</button></li>
							<li><button type="button" onClick={onOpenSettings}><IconLockClosed /> {t("sidebarCard.menuRecover")}</button></li>
							<li><button type="button" onClick={onOpenStorage}><IconFolder /> {t("sidebarCard.storageMenuItem")}</button></li>
							<li><button type="button" onClick={onOpenDiagnostics}><IconActivityLog /> {t("sidebarCard.menuDiagnostics")}</button></li>
							<li><button type="button" onClick={onOpenHelp}><IconHelpCircle /> {t("sidebarCard.menuHelp")}</button></li>
						</ul>
						<ul class="stack" style={{ "--gap": "1px" }}>
							<li><button type="button" onClick={lock}><IconExit /> {t("shell.logout")}</button></li>
						</ul>
					</div>
				</details>
			</div>

			{bio && <p class="account-bio truncate" style={{ "--lines": "2" }} title={bio}>{bio}</p>}
			{degraded && <p class="account-alert">{t(relay.labelKey)}</p>}
		</div>
	);
}
```

**Важно про пункты меню, ведущие на отдельный экран.** На узком экране
(`max-width: 47.99em`) панель — временный слой поверх содержимого. Если после
`onOpenSettings` панель останется открытой, человек увидит, что «ничего не
произошло». `app.jsx` должен закрывать панель (`setSidebarOpen(false)`) в
каждом обработчике, который меняет `place` — оберни `selectNavItem` так, чтобы
это происходило само, а не в семи местах вручную.

**Иконки.** Если `copy.jsx` и `dots-horizontal.jsx` в `src/ui/icons/` нет —
завести по образцу соседних файлов (тот же размер `viewBox`, `currentColor`,
`aria-hidden`). Не подставляй текстовые глифы вместо них.

### 4.3 Разметка в `app.jsx`

```jsx
<div class="pane__top stack" style={{ "--gap": "var(--space-2xs)" }}>
	<AccountCard
		onEditProfile={() => selectNavItem("profile")}
		onOpenStorage={() => selectNavItem("storage")}
		onOpenSettings={() => selectNavItem("settings")}
		onOpenHelp={() => selectNavItem("help")}
		onOpenDiagnostics={() => selectNavItem("diagnostics")}
		themeMode={themeMode}
		onToggleTheme={handleToggleTheme}
	/>
</div>
```

Остальная структура `<aside>` — без изменений: четыре региона
`pane__top` → `sidebar-row` → `pane__body` → `pane__bottom`, единственный
`.scroller` по-прежнему один и находится в `pane__body`.

---

## 5. Этап 4 — списки в `pane__body`

Три правки, все в CSS, разметка `nav-groups.jsx` меняется в одном месте.

**Отступы.** Сейчас у `.grouphead` горизонтальный отступ `--space-3xs`, а у
`.stream` — `--space-xs`. То есть имена в списке постоянно стоят на восемь
пикселей правее заголовков групп, и это видно только при наведении, когда
появляется подложка. Свести `.stream` к `padding: var(--space-3xs)` — по всем
четырём сторонам одинаково. Высота строки от этого не изменится: её задаёт
аватар в `--avatar-s`.

**Отклик на наведение.** У `.stream-row` было `var(--surface-raised)` —
`oklch(0.28 0.022 265)`, холодная серая плашка, спорящая с тёплым акцентом.
Заменить на слабую подмешку акцента. У `.grouphead` фоновую подложку убрать
совсем: заголовок — кнопка, отклик нужен, но хватает потепления текста и
сдвига стрелки у «все ›».

**Активная строка.** Её сейчас нет вообще — в списке из тридцати переписок не
видно, где находишься. Добавить состояние: `nav-groups.jsx` сравнивает
`place.value` с идентификатором строки и ставит класс `is-active` на
`<li class="stream-row">`.

---

## 6. Этап 5 — статус соединения молчит, пока всё в порядке

`ConnectionStatusPanel` сейчас всегда рисует две строки с URL реле и Blossom.
Это диагностика, а не окружающая информация, и её место — экран
«Диагностика», который в меню уже есть.

Переписать так: если `relayStatusInfo(...).tone === "ok"` **и**
`blossomStatus.value === "reachable"` — компонент возвращает `null`. Иначе
рисует одну компактную строку с точкой и текстом проблемы, без URL:

```jsx
<div class="conn bar" style={{ "--gap": "var(--space-2xs)" }} aria-live="polite">
	<span class="conn-dot" aria-hidden="true" />
	{t(worst.labelKey)}
</div>
```

`worst` — то из двух состояний, что хуже (`bad` важнее `warn`). Периодическую
проверку Blossom (`refreshBlossomStatus`, 30 с) оставить как есть.

Полные адреса реле и Blossom перенести на экран «Диагностика», если их там
ещё нет.

---

## 7. CSS целиком

Всё ниже — в `src/styles/custom.css`, в тот же раздел, где сейчас живут
правила сайдбара (около строк 720–920). Порядок правил сохраняй.

```css
/* ============================================================== *
 *  КАРТОЧКА УЧЁТНОЙ ЗАПИСИ                                       *
 *  Не <details>: три мелкие цели (портрет, «ключ», «ещё»),        *
 *  а не одна большая на всю карточку.                            *
 * ============================================================== */
.account {
	padding-block-end: var(--space-s);
}

/* Портрет во всю ширину колонки. Ловушка файла: <button> получает из
   @layer elements background-color/color/border/padding/font — все
   четыре обязаны быть здесь явно, иначе портрет станет акцентной
   кнопкой. */
.account-portrait {
	position: relative;
	display: block;
	inline-size: 100%;
	aspect-ratio: var(--account-ava-ratio);
	padding: 0;
	border: 0;
	border-radius: var(--radius);
	overflow: hidden;
	background-color: var(--surface-raised);
	background-image: none;
	color: inherit;
	font: inherit;
	cursor: pointer;
}
/* Аватар внутри портрета игнорирует --avatar: здесь он заполняет кадр. */
.account-portrait .account-avatar {
	inline-size: 100%;
	block-size: 100%;
	border-radius: 0;
	font-size: clamp(1.8rem, 20cqi, 2.6rem);
}
.account-portrait::after {
	content: attr(data-hint);
	position: absolute;
	inset-inline: 0;
	inset-block-end: 0;
	padding: var(--space-2xs) var(--space-xs);
	font-size: var(--step--2);
	color: oklch(0.98 0 0);
	background-image: linear-gradient(to top, oklch(0.15 0.02 var(--hue) / 0.72), transparent);
	transform: translateY(100%);
	transition: transform var(--transition-speed) var(--ease);
}
.account-portrait:hover::after,
.account-portrait:focus-visible::after {
	transform: translateY(0);
}

/* Точка присутствия. Дышит очень медленно — под prefers-reduced-motion
   глобальное правило minimal.css её остановит. */
.account-dot {
	position: absolute;
	inset-block-start: var(--space-2xs);
	inset-inline-end: var(--space-2xs);
	inline-size: 0.625rem;
	block-size: 0.625rem;
	border-radius: 50%;
	background-color: var(--good);
	box-shadow: 0 0 0 2px oklch(0.15 0.02 var(--hue) / 0.35);
	animation: account-dot-breathe 4s var(--transition-ease) infinite;
}
.account-dot--warn {
	background-color: var(--warn);
}
@keyframes account-dot-breathe {
	0%, 100% { opacity: 0.5 }
	50% { opacity: 1 }
}

.account-line {
	padding-block-start: var(--space-2xs);
}
.account-name {
	font-size: var(--step-0);
	font-weight: var(--weight-bold);
	line-height: 1.3;
	color: var(--fg);
}
.account-bio {
	font-size: var(--step--1);
	line-height: 1.4;
	color: var(--muted);
	margin: 0;
}
.account-alert {
	font-size: var(--step--2);
	line-height: 1.4;
	color: var(--warn);
	margin: 0;
}

/* ============================================================== *
 *  ЗАГОЛОВКИ ГРУПП                                               *
 * ============================================================== */
.grouphead {
	inline-size: 100%;
	background: none;
	border: none;
	/* тот же padding-inline, что у строк ниже: левый край заголовка и
	   левый край имени в списке стоят на одной вертикали ВСЕГДА, а не
	   только когда подложка наведения это показывает */
	padding: var(--space-s) var(--space-3xs) var(--space-2xs);
	margin-block-end: 0;
	color: var(--muted);
	cursor: pointer;
	transition: color var(--transition-speed) var(--transition-ease);
}
/* Подложки НЕТ намеренно: заголовок — кнопка, отклик нужен, но фон для
   этого слишком громкий. Хватает потепления текста и сдвига стрелки. */
.grouphead:hover,
.grouphead:focus-visible {
	color: var(--fg);
}
.grouphead-plain {
	padding: var(--space-s) var(--space-3xs) var(--space-2xs);
	margin-block-end: 0;
}
.grouphead__all {
	margin-inline-start: auto;
	text-transform: none;
	letter-spacing: normal;
	font-weight: var(--weight-normal);
	font-size: var(--step--2);
	color: var(--muted);
	transition: color var(--transition-speed) var(--transition-ease);
}
.grouphead__all::after {
	content: " ›";
	display: inline-block;
	transition: transform var(--transition-speed) var(--ease);
}
.grouphead:hover .grouphead__all {
	color: var(--accent);
}
.grouphead:hover .grouphead__all::after {
	transform: translateX(2px);
}

/* ============================================================== *
 *  СТРОКИ СПИСКА                                                 *
 * ============================================================== */
.streams {
	list-style: none;
	/* margin/padding НЕ дублируем: сброс minimal.css уже ставит их в
	   ноль для всех элементов — прежние строки были мёртвым кодом */
}
.stream-row {
	border-radius: var(--radius-sm);
	padding-inline-end: var(--space-3xs);
	transition: background-color var(--transition-speed) var(--transition-ease);
}
.stream-row:hover {
	background-color: color-mix(in oklch, var(--accent), transparent 92%);
}
.stream-row.is-active {
	background-color: color-mix(in oklch, var(--accent), transparent 88%);
	box-shadow: inset 2px 0 0 var(--accent);
}
.stream-row.is-active .stream__name {
	color: var(--fg);
	font-weight: 500;
}
.stream {
	min-inline-size: 0;
	background: none;
	border: none;
	padding: var(--space-3xs);
	color: var(--fg);
	font: inherit;
	font-size: var(--step--1);
	line-height: 1.35;
	text-align: start;
	cursor: pointer;
}
.stream-ava {
	flex: none;
	inline-size: var(--avatar-s);
	block-size: var(--avatar-s);
	border-radius: var(--radius-sm);
	background-color: var(--surface-raised);
	border: var(--border-width) solid var(--border);
	color: var(--muted);
	font-size: var(--step--1);
	font-weight: var(--weight-bold);
	object-fit: cover;
}
.stream__name {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-inline-size: 0;
}
.pin-toggle {
	flex: none;
	background: none;
	border: none;
	/* по горизонтали больше, чем по вертикали: иначе флажок упирается
	   в правый край подложки */
	padding: var(--space-3xs) var(--space-2xs);
	color: var(--accent);
	font-size: 0.95rem;
	line-height: 1;
	cursor: pointer;
	opacity: 0.25;
	transition: opacity var(--transition-speed) var(--transition-ease);
}
.stream-row:hover .pin-toggle,
.pin-toggle:focus-visible,
.pin-toggle[aria-pressed="true"] {
	opacity: 1;
}

/* ============================================================== *
 *  МЕНЮ (.menu-pop) — свет вместо монолита                       *
 * ============================================================== */
.menu-pop {
	/* существующие свойства позиционирования/рамки НЕ трогаем,
	   добавляем только два слоя света */
	background-image:
		radial-gradient(120% 150% at 100% -15%, color-mix(in oklch, var(--accent), transparent 88%), transparent 55%),
		linear-gradient(152deg, color-mix(in oklch, var(--accent-2), transparent 93%) 0%, transparent 48%);
}
.menu-pop ul + ul {
	border-block-start: var(--border-width) solid var(--border);
	padding-block-start: var(--space-3xs);
	margin-block-start: var(--space-3xs);
}
.menu-pop ul {
	list-style: none;
}

/* ============================================================== *
 *  СТАТУС СОЕДИНЕНИЯ — существует только при проблеме            *
 * ============================================================== */
.conn {
	padding: var(--space-2xs) var(--space-xs);
	font-size: var(--step--2);
	line-height: 1.4;
	color: var(--warn);
}
.conn-dot {
	flex: none;
	inline-size: 0.5rem;
	block-size: 0.5rem;
	border-radius: 50%;
	background-color: currentColor;
}

/* ============================================================== *
 *  ПАНЕЛЬ ЦЕЛИКОМ                                                *
 * ============================================================== */
.sidebar {
	/* свет из угла — та же подпись, что в ленте сообщений */
	background-image: radial-gradient(90% 30% at 100% 0%, color-mix(in oklch, var(--accent), transparent 92%), transparent 60%);
}
/* Было продублировано двумя селекторами (.pane__top .icon-btn и
   .sidebar-row .icon-btn) — после того как карточка перестала быть
   <details>, сводится к одному. */
.sidebar .icon-btn {
	inline-size: 1.75rem;
	block-size: 1.75rem;
	border-radius: var(--radius-sm);
	border-color: var(--border);
	color: var(--muted);
}
.sidebar .icon-btn:hover,
.sidebar .icon-btn:focus-visible {
	color: var(--accent);
	border-color: var(--accent);
	background-color: color-mix(in oklch, var(--accent), transparent 92%);
}
```

**Новый токен** — в `minimal.css`, `@layer tokens`:

```css
/* Пропорция портрета в карточке учётной записи. 1 — как в
   FEATURE-SPECS/VISUAL.md; 3/2 — заметно компактнее при той же
   узнаваемости. Меняется одним числом. */
--account-ava-ratio: 3 / 2;
```

`.account-portrait` требует `container-type: inline-size` на родителе, если
используется `20cqi` в размере буквы-заглушки — поставь его на `.account`.

---

## 8. Новые ключи локализации

Во **все двенадцать** файлов `src/ui/i18n/locales/*.json`. Русский —
эталонный, остальные переводи по смыслу, не оставляй английские заглушки.

| Ключ | ru |
|---|---|
| `account.portraitAria` | Профиль и аватар |
| `account.portraitHint` | Сменить фото |
| `account.copyKeyAria` | Скопировать мой ключ |
| `account.menuAria` | Меню учётной записи |
| `account.keyCopied` | Ключ скопирован |
| `account.keyCopyFailed` | Не удалось скопировать ключ |

`account.portraitHint` подставляется в разметку атрибутом
`data-hint={t("account.portraitHint")}` на `.account-portrait` — CSS читает
его через `content: attr(data-hint)`, чтобы текст не оказался зашит в
стилях мимо локализации.

Удалить ключ `sidebarCard.menuDeleteAccount`, если он больше нигде не
используется (проверь `grep`), и `sidebarCard.profileAria`.

---

## 9. Чего НЕ делать

* Не заводить новых композиционных классов и не менять существующие в
  `@layer composition`.
* Не менять `.menu` (базовый паттерн выпадашки) — он общий для всего
  приложения, правки коснутся десятка мест.
* Не трогать `.pane__top` / `.sidebar-row` / `.pane__body` / `.pane__bottom` —
  структура четырёх регионов остаётся, меняется только их содержимое.
* Не добавлять второй `.scroller` на путь `shell → sidebar → лист`. Он один,
  в `pane__body` (`PROCESS-DOCS/REGLAMENT.md` §1).
* Не делать вкладки «Меню / Аккаунт». Это обсуждалось и отклонено: на узком
  экране панель — временный слой, а вкладка внутри временного слоя удваивает
  режимность.
* Не подгонять высоту карточки под аватар подсчётом строк биографии в
  JavaScript. Биография вынесена из кликабельной области именно затем, чтобы
  считать было не нужно.
* Не заменять `text-overflow: ellipsis` программной обрезкой по числу
  символов: символ не единица ширины.

---

## 10. Приёмка

Проверяется вручную, в браузере, в обеих темах.

1. `grep -r "menu__pop\|idwrap\|idcard__\|menu-item-hint\|account-avatar-sm\|account-avatar-large" src/` — пусто.
2. Карточка не реагирует на клик мимо трёх целей: между именем и кнопками
   ничего не открывается.
3. Портрет по клику открывает «Профиль»; при наведении снизу выезжает
   подпись; меню при этом НЕ открывается.
4. Кнопка ключа кладёт `npub…` в буфер и показывает всплывающее уведомление.
5. Меню открывается по многоточию, закрывается кликом вне (это уже делает
   `use-details-menu.js`), пункты разбиты на три группы с линией на стыке.
6. «Удалить учётную запись» в меню отсутствует, в «Настройках» — на месте
   и работает.
7. Левый край имени в строке списка совпадает по вертикали с левым краем
   заголовка группы **без** наведения. Проверяется линейкой в devtools, не
   на глаз.
8. Подложка при наведении на строку — тёплая, не серо-синяя. У заголовка
   группы подложки нет вовсе.
9. Открытая переписка помечена полоской слева и видна без наведения.
10. При живом реле внизу панели пусто; при обрыве появляется одна строка,
    точка на портрете желтеет.
11. Биография длиной в абзац обрезается на второй строке многоточием;
    логин длиной в 40 символов обрезается многоточием и не наезжает на
    кнопки.
12. Ширина окна 480 px: панель выезжает поверх содержимого, нажатие любого
    пункта меню, ведущего на экран, закрывает панель.
13. `prefers-reduced-motion: reduce`: точка не дышит, подсказка портрета не
    выезжает, стрелка «все ›» не сдвигается.
14. Существующие тесты проходят: `npm test`.

Каждый этап (2 → 3 → 4 → 5) — отдельный коммит. После первого коммита
внешний вид обязан быть неотличим от текущего.
