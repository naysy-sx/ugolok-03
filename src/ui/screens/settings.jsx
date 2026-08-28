import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig, lock } from "../signals/auth.js";
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
import { requestNotificationPermission, NOTIFICATION_LEVELS } from "../../domain/notifications/notifier.js";
import { contacts, refreshContacts } from "../signals/contacts.js";
import { listOwnedChannels, listSubscribedChannels } from "../../domain/content/channel.js";
import { ContactIdentity } from "./contacts.jsx";
import { DEFAULT_CUSTOM_PALETTE, applyCustomPalette } from "../theme/palette-apply.js";
import { nudgeHueOutOfForbiddenZones } from "../theme/palette-generator.js";
import { SCALE_OPTIONS, applyUiScale } from "../theme/ui-scale.js";
import { applyThemeMode } from "../theme/theme-mode.js";
import { SUPPORTED_LOCALES, setLocale, t, errorMessage } from "../signals/i18n.js";
import Screen from "../components/screen.jsx";
import IconTrash from "../icons/trash.jsx";
import IconPlus from "../icons/plus.jsx";
import IconGear from "../icons/gear.jsx";
import IconBell from "../icons/bell.jsx";
import IconServer from "../icons/server.jsx";
import IconPower from "../icons/power.jsx";
import IconChevronDown from "../icons/chevron-down.jsx";

// Этап 47 — уровень уведомления как единый select (упорядоченная шкала off/badge/
// popup/sound, DESIGN.md), не 3 независимых чекбокса.
const LEVEL_LABEL_KEYS = {
	off: "settings.level.off",
	badge: "settings.level.badge",
	popup: "settings.level.popup",
	sound: "settings.level.sound",
};

const DEFAULT_SENTINEL = "__default__";

// Этап 70 — именованные пресеты-стартовые точки нового генератора палитры
// (accent-palette.js/ACCENT_COLORS удалены целиком, см. CONTRACTS.md): только
// hue, cNeutral пресет не трогает (остаётся текущим значением пользователя —
// "Настроить" ниже позволяет донастроить обе оси после выбора стартовой точки).
// Значения — вне запретных зон служебных тонов (ACCENT_FORBIDDEN_ZONES:
// 25/85/145/235 ±20°), проверено расчётом при подборе.
const PALETTE_PRESETS = [
	{ id: "amber", hue: 55 },
	{ id: "olive", hue: 115 },
	{ id: "teal", hue: 172 },
	{ id: "cyan", hue: 184 },
	{ id: "sky", hue: 196 },
	{ id: "azure", hue: 208 },
	{ id: "blue", hue: 260 },
	{ id: "indigo", hue: 272 },
	{ id: "violet", hue: 284 },
	{ id: "lavender", hue: 296 },
	{ id: "purple", hue: 308 },
	{ id: "amethyst", hue: 320 },
	{ id: "magenta", hue: 332 },
	{ id: "fuchsia", hue: 344 },
	{ id: "pink", hue: 356 },
];

// customPalette — всегда {cNeutral, accentHue}, никогда null (вызывающий код
// settings.jsx уже подставляет DEFAULT_CUSTOM_PALETTE). onChange(next) — при
// клике по пресету/движении любого слайдера.
function PaletteSection({ customPalette, onChange }) {
	const instanceId = useId();

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
}

// Один select для дефолта категории/подкатегории (только 4 уровня, без "по умолчанию").
function LevelSelect({ id, value, onChange, disabled }) {
	return (
		<select id={id} class="set-row__control" value={value} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value)}>
			{NOTIFICATION_LEVELS.map((level) => (
				<option key={level} value={level}>
					{t(LEVEL_LABEL_KEYS[level])}
				</option>
			))}
		</select>
	);
}

// Select для per-entity override — 5-й вариант "По умолчанию" сверху (найденный
// пользователем принцип: пустой override не создаётся, пока строку явно не тронули).
function OverrideSelect({ id, override, onChange, disabled }) {
	return (
		<select id={id} class="set-row__control" value={override ?? DEFAULT_SENTINEL} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value === DEFAULT_SENTINEL ? undefined : e.currentTarget.value)}>
			<option value={DEFAULT_SENTINEL}>{t("settings.level.default")}</option>
			{NOTIFICATION_LEVELS.map((level) => (
				<option key={level} value={level}>
					{t(LEVEL_LABEL_KEYS[level])}
				</option>
			))}
		</select>
	);
}

// CONTRACTS.md, этап 34 — пользователь: "в профиль необходимо добавить возможность
// добавления и переключения на другие relay сервера". Blossom — тот же паттерн, без
// переподключения (URL читается per-upload, не держит постоянное соединение).
function ServerListEditor({ title, urlPlaceholder, urls, activeUrl, onAdd, onRemove, onSetActive, busy }) {
	const [newUrl, setNewUrl] = useState("");
	const [error, setError] = useState("");

	async function handleAdd(e) {
		e.preventDefault();
		const trimmed = newUrl.trim();
		if (!trimmed) return;
		setError("");
		try {
			await onAdd(trimmed);
			setNewUrl("");
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	async function runAction(fn) {
		setError("");
		try {
			await fn();
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	return (
		<section class="stack" style={{ "--gap": "var(--space-2xs)" }} aria-labelledby={`srv-${title}`}>
			<h3 id={`srv-${title}`} class="sect-title">
				{title}
			</h3>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<ul role="list" class="srv__list stack" style={{ "--gap": "var(--space-2xs)" }}>
				{urls.map((url) => (
					<li key={url} class="srv__item row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
						<span class="srv__url">{url}</span>
						{url === activeUrl && <span class="badge-on">{t("profile.server.activeLabel")}</span>}
						{url !== activeUrl && (
							<button type="button" class="btn--ghost" disabled={busy} onClick={() => runAction(() => onSetActive(url))}>
								{t("profile.server.makeActiveButton")}
							</button>
						)}
						<button
							type="button"
							class="icon-btn"
							disabled={busy}
							onClick={() => runAction(() => onRemove(url))}
							aria-label={t("profile.server.deleteAria", { url })}
						>
							<IconTrash />
						</button>
					</li>
				))}
				{urls.length === 0 && (
					<li style={{ color: "var(--muted)" }} class="srv__item">
						{t("profile.server.emptyList")}
					</li>
				)}
			</ul>
			<form class="srv__add row" style={{ "--gap": "var(--space-2xs)" }} onSubmit={handleAdd}>
				<label class="visually-hidden" for={`${title}-new-url`}>
					{t("profile.server.addLabel")}
				</label>
				<input
					id={`${title}-new-url`}
					type="text"
					placeholder={urlPlaceholder}
					value={newUrl}
					onInput={(e) => setNewUrl(e.currentTarget.value)}
				/>
				<button type="submit" class="btn--ghost" disabled={busy || !newUrl.trim()}>
					<IconPlus /> {t("common.add")}
				</button>
			</form>
		</section>
	);
}

// Этап 58 — мультирелейный транспорт: relayUrls теперь {url,read,write}[],
// "один активный" не имеет смысла при одновременной работе с несколькими
// (CONTRACTS.md/DESIGN.md, этап 58). Blossom остаётся single-active
// (ServerListEditor выше, без изменений) — это отдельный, более поздний
// вопрос (этап 62/63), не путать.
function RelayListEditor({ urls, onAdd, onRemove, onSetRole, busy }) {
	const [newUrl, setNewUrl] = useState("");
	const [error, setError] = useState("");

	async function handleAdd(e) {
		e.preventDefault();
		const trimmed = newUrl.trim();
		if (!trimmed) return;
		setError("");
		try {
			await onAdd(trimmed);
			setNewUrl("");
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	async function runAction(fn) {
		setError("");
		try {
			await fn();
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	return (
		<section class="stack" style={{ "--gap": "var(--space-2xs)" }} aria-labelledby="srv-relay">
			<h3 id="srv-relay" class="sect-title">
				{t("profile.relay.heading")}
			</h3>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<ul role="list" class="srv__list stack" style={{ "--gap": "var(--space-2xs)" }}>
				{urls.map((r) => (
					<li key={r.url} class="srv__item row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
						<span class="srv__url">{r.url}</span>
						<label>
							<input
								type="checkbox"
								checked={r.read}
								disabled={busy}
								onChange={(e) => runAction(() => onSetRole(r.url, { read: e.currentTarget.checked, write: r.write }))}
							/>
							{t("profile.relay.readLabel")}
						</label>
						<label>
							<input
								type="checkbox"
								checked={r.write}
								disabled={busy}
								onChange={(e) => runAction(() => onSetRole(r.url, { read: r.read, write: e.currentTarget.checked }))}
							/>
							{t("profile.relay.writeLabel")}
						</label>
						<button
							type="button"
							class="icon-btn"
							disabled={busy}
							onClick={() => runAction(() => onRemove(r.url))}
							aria-label={t("profile.server.deleteAria", { url: r.url })}
						>
							<IconTrash />
						</button>
					</li>
				))}
				{urls.length === 0 && (
					<li style={{ color: "var(--muted)" }} class="srv__item">
						{t("profile.server.emptyList")}
					</li>
				)}
			</ul>
			<form class="srv__add row" style={{ "--gap": "var(--space-2xs)" }} onSubmit={handleAdd}>
				<label class="visually-hidden" for="relay-new-url">
					{t("profile.server.addLabel")}
				</label>
				<input id="relay-new-url" type="text" placeholder="wss://relay.example.com" value={newUrl} onInput={(e) => setNewUrl(e.currentTarget.value)} />
				<button type="submit" class="btn--ghost" disabled={busy || !newUrl.trim()}>
					<IconPlus /> {t("common.add")}
				</button>
			</form>
		</section>
	);
}

// Этап 63, И3 — экран сопряжения с self-hosted инстансом (agent/install.sh).
// Вставка пейринг-кода ДЕКОДИРУЕТСЯ и ПРОВЕРЯЕТСЯ живым запросом /status
// ДО сохранения (pairSelfHostedServer) — не сохраняем то, до чего не смогли
// достучаться (частая причина отказа — пользователь ещё не открыл https://
// host:port/ в отдельной вкладке и не принял самоподписанный сертификат,
// см. CONTRACTS.md "Этап 63, И3": браузер не даёт JS проверить TLS-
// сертификат напрямую, единственный реальный путь — штатный browser-flow).
function SelfHostedSection({ ownerPubkey, privKey, dbKey }) {
	const [settings, setSettings] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [code, setCode] = useState("");
	const [status, setStatus] = useState(null);

	async function refresh() {
		setSettings(await loadUiSettings(ownerPubkey, dbKey));
	}

	useEffect(() => {
		refresh().catch(() => {});
	}, [ownerPubkey]);

	async function attemptPair(force) {
		setError("");
		setBusy(true);
		try {
			const pairing = decodePairingCode(code.trim());
			const agentStatus = await fetchAgentStatus(pairing);
			await pairSelfHostedServer(ownerPubkey, privKey, dbKey, pairing, publish, { force });
			setStatus(agentStatus);
			setCode("");
			await refresh();
		} catch (err) {
			if (err instanceof SelfHostedFingerprintMismatchError) {
				const confirmed = window.confirm(t("profile.selfHosted.fingerprintMismatchConfirm"));
				if (confirmed) {
					setBusy(false);
					await attemptPair(true);
					return;
				}
				setError(t("profile.selfHosted.pairingCancelled"));
			} else {
				setError(errorMessage(err));
			}
		} finally {
			setBusy(false);
		}
	}

	async function handlePairSubmit(e) {
		e.preventDefault();
		if (!code.trim() || busy) return;
		await attemptPair(false);
	}

	async function handleUnpair() {
		if (!window.confirm(t("profile.selfHosted.unpairConfirm"))) return;
		setBusy(true);
		setError("");
		try {
			await unpairSelfHostedServer(ownerPubkey, privKey, dbKey, publish);
			setStatus(null);
			await refresh();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleRefreshStatus() {
		if (!settings?.selfHostedServer) return;
		setBusy(true);
		setError("");
		try {
			setStatus(await fetchAgentStatus(settings.selfHostedServer));
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	if (!settings) return null;
	const paired = settings.selfHostedServer;

	return (
		<section class="stack" style={{ "--gap": "var(--space-2xs)" }} aria-labelledby="selfhost-heading">
			<h3 id="selfhost-heading" class="sect-title">
				{t("profile.selfHosted.heading")}
			</h3>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			{paired ? (
				<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					<p>
						{t("profile.selfHosted.connectedLabel")}{" "}
						<strong>
							{paired.host}:{paired.port}
						</strong>
					</p>
					<p style={{ color: "var(--muted)", fontSize: "0.85em" }}>{t("profile.selfHosted.fingerprintLabel", { fingerprint: paired.fingerprint })}</p>
					{status && (
						<ul role="list">
							{(status.services || []).map((s) => (
								<li key={s.Service}>
									{s.Service}: {s.State}
								</li>
							))}
						</ul>
					)}
					<div style={{ display: "flex", gap: "var(--space-2xs)" }}>
						<button type="button" class="btn--ghost" disabled={busy} onClick={handleRefreshStatus}>
							{t("profile.selfHosted.refreshStatusButton")}
						</button>
						<button type="button" class="btn--ghost btn--warn" disabled={busy} onClick={handleUnpair}>
							{t("profile.selfHosted.disconnectButton")}
						</button>
					</div>
				</div>
			) : (
				<form class="stack" style={{ "--gap": "var(--space-2xs)" }} onSubmit={handlePairSubmit}>
					<p style={{ color: "var(--muted)" }}>
						{t("profile.selfHosted.instructionsBeforeCode")} <code>install.sh</code> {t("profile.selfHosted.instructionsAfterCode")}
					</p>
					<label class="visually-hidden" for="pairing-code">
						{t("profile.selfHosted.pairingCodeLabel")}
					</label>
					<textarea
						id="pairing-code"
						rows={3}
						placeholder={t("profile.selfHosted.pairingCodePlaceholder")}
						value={code}
						onInput={(e) => setCode(e.currentTarget.value)}
					/>
					<button type="submit" class="btn--ghost" disabled={busy || !code.trim()}>
						{t("profile.selfHosted.connectButton")}
					</button>
				</form>
			)}
		</section>
	);
}

function RelayBlossomSection({ ownerPubkey, privKey, dbKey }) {
	const [settings, setSettings] = useState(null);
	const [busy, setBusy] = useState(false);

	async function refresh() {
		setSettings(await loadUiSettings(ownerPubkey, dbKey));
	}

	useEffect(() => {
		refresh().catch(() => {});
	}, [ownerPubkey]);

	async function withBusy(fn) {
		setBusy(true);
		try {
			await fn();
			await refresh();
		} finally {
			setBusy(false);
		}
	}

	if (!settings) return null;

	return (
		<div class="stack" style={{ "--gap": "var(--space-m)" }}>
			<RelayListEditor
				urls={settings.relayUrls}
				busy={busy}
				onAdd={(url) => withBusy(() => addRelayUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onRemove={(url) => withBusy(() => removeRelayUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onSetRole={(url, role) =>
					withBusy(async () => {
						await setRelayRole(ownerPubkey, privKey, dbKey, url, role, publish);
						await reconnectWithNewSettings(ownerPubkey, privKey, dbKeySig.value);
					})
				}
			/>
			<ServerListEditor
				title={t("profile.blossomServersTitle")}
				urlPlaceholder="https://blossom.example.com"
				urls={settings.blossomUrls}
				activeUrl={settings.activeBlossomUrl}
				busy={busy}
				onAdd={(url) => withBusy(() => addBlossomUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onRemove={(url) => withBusy(() => removeBlossomUrl(ownerPubkey, privKey, dbKey, url, publish))}
				onSetActive={(url) => withBusy(() => setActiveBlossomUrl(ownerPubkey, privKey, dbKey, url, publish))}
			/>
		</div>
	);
}

// Панель раздела. "Настройки" были плоским свитком из девяти <section
// class="stack"> без единой границы, и заголовки в них наследовали шрифт
// текста инлайновым стилем, то есть элементный слой заголовка был выжжен,
// а обратно возвращён только жир. Девять разделов выглядели одинаково;
// это и было главной причиной ощущения "на скорую руку", а не отступы.
function Panel({ title, hint, icon: Icon, danger, children }) {
	return (
		<section class={`panel stack${danger ? " panel--danger" : ""}`} style={{ "--gap": "var(--space-m)" }}>
			{title && (
				<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
					<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
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
		<div class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
			{/* Живой фидбег: --align — CSS custom property, наследуется. .set-row
			    ставит --align:center для СЕБЯ (вертикальное центрирование строки),
			    но .set-row__text — тоже .stack (читает тот же var(--align)) и
			    наследовал center от родителя, из-за чего подпись центрировалась
			    по горизонтали внутри своего блока вместо обычного выравнивания
			    по левому краю. Обрываем наследование явным normal. */}
			<div class="set-row__text stack" style={{ "--gap": "2px", "--align": "normal" }}>
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
// принципе. Внутри теперь те же SetRow, а не табличная разметка.
function Disclosure({ summary, children }) {
	return (
		<details class="exceptions">
			<summary class="bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
				<IconChevronDown />
				{summary}
			</summary>
			<div class="exceptions__body stack" style={{ "--gap": "var(--space-s)" }}>
				{children}
			</div>
		</details>
	);
}

// Мокап пользователя (v0.1, https://ibb.co/WWQNbYJ6) — раздел "Приватность" вне
// скоупа (решение пользователя, CONTRACTS.md/этап 34): presence-протокол и поиск
// пользователей не существуют в архитектуре проекта, это отдельная будущая фича.
export default function Settings() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;

	const [settings, setSettings] = useState(null);
	const [error, setError] = useState("");
	const [myChannels, setMyChannels] = useState([]);
	// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 47-довесок): notifications.enabled=true ПО
	// УМОЛЧАНИЮ означает, что handleToggleEnabled (единственное место, запрашивающее
	// разрешение браузера) практически никогда не срабатывает — чекбокс уже включён,
	// пользователю нечего переключать. Разрешение оставалось "default" НАВСЕГДА,
	// всплывашки молча не показывались (showPopup гейтится permission==='granted').
	// Статус — ОТДЕЛЬНОЕ состояние, не производное от settings, чтобы кнопка ниже
	// могла явно предложить запросить его.
	const [browserPermission, setBrowserPermission] = useState(() => globalThis.Notification?.permission ?? "unsupported");
	const [tab, setTab] = useState("view");
	const instanceId = useId();

	useEffect(() => {
		loadUiSettings(ownerPubkey, dbKey).then((loaded) => {
			setSettings(loaded);
			applyCustomPalette(loaded.customPalette);
			applyUiScale(loaded.uiScale);
			setLocale(loaded.language);
		});
		refreshContacts(ownerPubkey);
		// Этап 47 — список каналов ДЛЯ ТАБЛИЦЫ уведомлений: владельческие+подписанные
		// (не "доступные" — там ещё нет права ни на что, уведомлять не о чем), объединены
		// в ОДИН список без дублей (находка пользователя — не плодить список 3 раза).
		Promise.all([listOwnedChannels(ownerPubkey, dbKey), listSubscribedChannels(ownerPubkey, dbKey)]).then(([owned, subscribed]) => {
			setMyChannels([...owned, ...subscribed]);
		});
	}, [ownerPubkey]);

	async function persist(next) {
		setSettings(next);
		try {
			await saveUiSettings(ownerPubkey, privKey, dbKey, next, publish);
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	// nudgeHueOutOfForbiddenZones — слайдер оттенка можно протащить курсором ЧЕРЕЗ
	// запретную зону (браузер не мешает промежуточным значениям input[type=range]);
	// без сдвига здесь applyCustomPalette->generatePalette бросил бы
	// PaletteConfigError прямо во время перетаскивания.
	function handlePaletteChange(next) {
		const safe = { cNeutral: next.cNeutral, accentHue: nudgeHueOutOfForbiddenZones(next.accentHue) };
		applyCustomPalette(safe); // мгновенный визуальный отклик, без ожидания записи в БД
		persist({ ...settings, customPalette: safe });
	}

	function handleScaleChange(scaleId) {
		applyUiScale(scaleId);
		persist({ ...settings, uiScale: scaleId });
	}

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

	function handleLanguageChange(code) {
		setLocale(code); // мгновенный визуальный отклик, тот же паттерн, что applyCustomPalette
		persist({ ...settings, language: code });
	}

	async function handleToggleEnabled(checked) {
		if (checked) {
			await handleRequestPermission();
		}
		persist({ ...settings, notifications: { ...settings.notifications, enabled: checked } });
	}

	async function handleRequestPermission() {
		const permission = await requestNotificationPermission();
		setBrowserPermission(permission);
		if (permission !== "granted") {
			setError(t("settings.permissionDeniedError"));
		}
	}

	function handleContactLevel(subcategory, level) {
		persist({
			...settings,
			notifications: { ...settings.notifications, contacts: { ...settings.notifications.contacts, [subcategory]: level } },
		});
	}

	function handleMessagesDefault(level) {
		persist({
			...settings,
			notifications: { ...settings.notifications, messages: { ...settings.notifications.messages, default: level } },
		});
	}

	function handleMessagesOverride(contactPubkey, level) {
		const overrides = { ...settings.notifications.messages.overrides };
		if (level === undefined) delete overrides[contactPubkey];
		else overrides[contactPubkey] = level;
		persist({ ...settings, notifications: { ...settings.notifications, messages: { ...settings.notifications.messages, overrides } } });
	}

	function handleChannelsDefault(subcategory, level) {
		persist({
			...settings,
			notifications: { ...settings.notifications, channels: { ...settings.notifications.channels, [subcategory]: level } },
		});
	}

	function handleChannelOverride(channelId, subcategory, level) {
		const overrides = { ...settings.notifications.channels.overrides };
		const forChannel = { ...overrides[channelId] };
		if (level === undefined) delete forChannel[subcategory];
		else forChannel[subcategory] = level;
		if (Object.keys(forChannel).length === 0) delete overrides[channelId];
		else overrides[channelId] = forChannel;
		persist({ ...settings, notifications: { ...settings.notifications, channels: { ...settings.notifications.channels, overrides } } });
	}

	function handleRepliesLevel(level) {
		persist({ ...settings, notifications: { ...settings.notifications, replies: level } });
	}

	function handleModerationReportsLevel(level) {
		persist({ ...settings, notifications: { ...settings.notifications, moderation: { ...settings.notifications.moderation, reports: level } } });
	}

	// Этап 47-довесок-3 — новая категория: заявка (MLS Welcome) от НЕЗНАКОМЦА,
	// глобальный уровень без per-entity (тот же приём, что replies).
	function handleInboxLevel(level) {
		persist({ ...settings, notifications: { ...settings.notifications, inbox: level } });
	}

	if (!settings) {
		return (
			<Screen title={t("nav.settings")}>
				<p style={{ color: "var(--muted)" }}>{t("settings.loadingSettings")}</p>
			</Screen>
		);
	}

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
							style={{ "--gap": "var(--space-2xs)", "--align": "center" }}
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
						<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
							<span class="set-row__text">{t("settings.enableNotifications")}</span>
							<input type="checkbox" class="set-row__switch" checked={n.enabled} onChange={(e) => handleToggleEnabled(e.currentTarget.checked)} />
						</label>

						{n.enabled && browserPermission !== "granted" && browserPermission !== "unsupported" && (
							<p role="alert" class="callout callout--warn row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
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
						<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
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
}
