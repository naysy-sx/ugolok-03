import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig, lock } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import { loadUiSettings, saveUiSettings } from "../../domain/settings/ui-settings.js";
import { requestNotificationPermission, NOTIFICATION_LEVELS } from "../../domain/notifications/notifier.js";
import { listAccounts } from "../../core/crypto/keystore.js";
import { contacts, refreshContacts } from "../signals/contacts.js";
import { listOwnedChannels, listSubscribedChannels } from "../../domain/content/channel.js";
import { ContactIdentity } from "./contacts.jsx";
import { ACCENT_COLORS, applyAccentColor } from "../theme/accent-palette.js";
import { SCALE_OPTIONS, applyUiScale } from "../theme/ui-scale.js";
import { SUPPORTED_LOCALES, setLocale, t, errorMessage } from "../signals/i18n.js";
import Screen from "../components/screen.jsx";
import MnemonicReveal from "../components/mnemonic-reveal.jsx";
import DeleteAccountPanel from "../components/delete-account-panel.jsx";

// Этап 47 — уровень уведомления как единый select (упорядоченная шкала off/badge/
// popup/sound, DESIGN.md), не 3 независимых чекбокса.
const LEVEL_LABEL_KEYS = {
	off: "settings.level.off",
	badge: "settings.level.badge",
	popup: "settings.level.popup",
	sound: "settings.level.sound",
};

const DEFAULT_SENTINEL = "__default__";

// Один select для дефолта категории/подкатегории (только 4 уровня, без "по умолчанию").
function LevelSelect({ id, value, onChange, disabled }) {
	return (
		<select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value)}>
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
		<select id={id} value={override ?? DEFAULT_SENTINEL} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value === DEFAULT_SENTINEL ? undefined : e.currentTarget.value)}>
			<option value={DEFAULT_SENTINEL}>{t("settings.level.default")}</option>
			{NOTIFICATION_LEVELS.map((level) => (
				<option key={level} value={level}>
					{t(LEVEL_LABEL_KEYS[level])}
				</option>
			))}
		</select>
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
	const [hasMnemonic, setHasMnemonic] = useState(false);
	const [myChannels, setMyChannels] = useState([]);
	// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 47-довесок): notifications.enabled=true ПО
	// УМОЛЧАНИЮ означает, что handleToggleEnabled (единственное место, запрашивающее
	// разрешение браузера) практически никогда не срабатывает — чекбокс уже включён,
	// пользователю нечего переключать. Разрешение оставалось "default" НАВСЕГДА,
	// всплывашки молча не показывались (showPopup гейтится permission==='granted').
	// Статус — ОТДЕЛЬНОЕ состояние, не производное от settings, чтобы кнопка ниже
	// могла явно предложить запросить его.
	const [browserPermission, setBrowserPermission] = useState(() => globalThis.Notification?.permission ?? "unsupported");
	const instanceId = useId();

	useEffect(() => {
		loadUiSettings(ownerPubkey, dbKey).then((loaded) => {
			setSettings(loaded);
			applyAccentColor(loaded.accentColorId);
			applyUiScale(loaded.uiScale);
			setLocale(loaded.language);
		});
		listAccounts().then((accounts) => {
			setHasMnemonic(!!accounts.find((a) => a.id === ownerPubkey)?.hasMnemonic);
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

	function handleAccentClick(colorId) {
		applyAccentColor(colorId); // мгновенный визуальный отклик, без ожидания записи в БД
		persist({ ...settings, accentColorId: colorId });
	}

	function handleScaleChange(scaleId) {
		applyUiScale(scaleId);
		persist({ ...settings, uiScale: scaleId });
	}

	function handleLanguageChange(code) {
		setLocale(code); // мгновенный визуальный отклик, тот же паттерн, что applyAccentColor
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
		<Screen title={t("nav.settings")}>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<label for={`${instanceId}-scale`}>{t("settings.scaleLabel")}</label>
				<select id={`${instanceId}-scale`} value={settings.uiScale} onChange={(e) => handleScaleChange(e.currentTarget.value)}>
					{SCALE_OPTIONS.map((opt) => (
						<option key={opt.id} value={opt.id}>
							{opt.label}
						</option>
					))}
				</select>
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("settings.accentColorTitle")}</h2>
				<div class="cluster" role="group" aria-label={t("settings.accentColorTitle")}>
					{ACCENT_COLORS.map((c) => (
						<button
							key={c.id}
							type="button"
							aria-pressed={settings.accentColorId === c.id}
							onClick={() => handleAccentClick(c.id)}
							class="cluster"
							style={{
								"--cluster-gap": "var(--space-3xs)",
								alignItems: "center",
								border: settings.accentColorId === c.id ? "2px solid var(--fg)" : "var(--border-width) solid var(--border)",
							}}
						>
							<span
								aria-hidden="true"
								style={{
									display: "inline-block",
									width: "1.25rem",
									height: "1.25rem",
									borderRadius: "50%",
									background: `oklch(0.6 0.17 ${c.hue})`,
								}}
							/>
							{c.label}
						</button>
					))}
				</div>
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("settings.language.sectionTitle")}</h2>
				<label for={`${instanceId}-language`}>{t("settings.language.label")}</label>
				<select id={`${instanceId}-language`} value={settings.language} onChange={(e) => handleLanguageChange(e.currentTarget.value)}>
					{SUPPORTED_LOCALES.map((locale) => (
						<option key={locale.code} value={locale.code}>
							{locale.nativeName}
						</option>
					))}
				</select>
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-s)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("settings.notificationsTitle")}</h2>

				<label class="cluster" style={{ alignItems: "center" }}>
					<input type="checkbox" checked={n.enabled} onChange={(e) => handleToggleEnabled(e.currentTarget.checked)} />
					{t("settings.enableNotifications")}
				</label>

				{n.enabled && browserPermission !== "granted" && browserPermission !== "unsupported" && (
					<p
						role="alert"
						class="cluster"
						style={{ alignItems: "center", justifyContent: "space-between", background: "var(--surface)", padding: "var(--space-2xs)", borderRadius: "var(--radius)" }}
					>
						{browserPermission === "denied"
							? t("settings.browserBlockedNotifications")
							: t("settings.browserNotAskedNotifications")}
						{browserPermission !== "denied" && (
							<button type="button" onClick={handleRequestPermission}>
								{t("settings.requestPermissionButton")}
							</button>
						)}
					</p>
				)}

				<div class="flow" style={{ "--flow-space": "var(--space-2xs)", opacity: n.enabled ? 1 : 0.5 }} inert={!n.enabled || undefined}>
					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("nav.contacts")}</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							{t("settings.newContactRequestsLabel")}
							<LevelSelect id={`${instanceId}-contacts-newRequests`} value={n.contacts.newRequests} onChange={(l) => handleContactLevel("newRequests", l)} />
						</label>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							{t("settings.requestAcceptedLabel")}
							<LevelSelect id={`${instanceId}-contacts-accepted`} value={n.contacts.accepted} onChange={(l) => handleContactLevel("accepted", l)} />
						</label>
					</section>

					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("nav.messages")}</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							{t("settings.defaultForNewLabel")}
							<LevelSelect id={`${instanceId}-messages-default`} value={n.messages.default} onChange={handleMessagesDefault} />
						</label>
						{contacts.value.length > 0 && (
							<table>
								<caption class="visually-hidden">{t("settings.perContactNotificationsCaption")}</caption>
								<thead>
									<tr>
										<th scope="col">{t("nav.contacts")}</th>
										<th scope="col">{t("settings.notificationColumnHeader")}</th>
									</tr>
								</thead>
								<tbody>
									{contacts.value.map((pubkey) => (
										<tr key={pubkey}>
											<td>
												<ContactIdentity pubkey={pubkey} />
											</td>
											<td>
												<OverrideSelect
													id={`${instanceId}-messages-${pubkey}`}
													override={n.messages.overrides[pubkey]}
													onChange={(l) => handleMessagesOverride(pubkey, l)}
												/>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</section>

					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("nav.channels")}</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							{t("settings.postsDefaultLabel")}
							<LevelSelect id={`${instanceId}-channels-posts`} value={n.channels.posts} onChange={(l) => handleChannelsDefault("posts", l)} />
						</label>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							{t("settings.commentsDefaultLabel")}
							<LevelSelect id={`${instanceId}-channels-comments`} value={n.channels.comments} onChange={(l) => handleChannelsDefault("comments", l)} />
						</label>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							{t("settings.chatDefaultLabel")}
							<LevelSelect id={`${instanceId}-channels-chat`} value={n.channels.chat} onChange={(l) => handleChannelsDefault("chat", l)} />
						</label>
						{myChannels.length > 0 && (
							// Находка пользователя — список каналов пишется РОВНО ОДИН РАЗ, три
							// колонки (не три отдельных списка), CONTRACTS.md этап 47.
							<table>
								<caption class="visually-hidden">{t("settings.perChannelNotificationsCaption")}</caption>
								<thead>
									<tr>
										<th scope="col">{t("nav.channels")}</th>
										<th scope="col">{t("settings.postsColumnHeader")}</th>
										<th scope="col">{t("settings.commentsColumnHeader")}</th>
										<th scope="col">{t("settings.chatColumnHeader")}</th>
									</tr>
								</thead>
								<tbody>
									{myChannels.map((c) => (
										<tr key={c.id}>
											<td>{c.name || t("channels.card.untitled")}</td>
											{["posts", "comments", "chat"].map((sub) => (
												<td key={sub}>
													<OverrideSelect
														id={`${instanceId}-channels-${c.id}-${sub}`}
														override={n.channels.overrides[c.id]?.[sub]}
														onChange={(l) => handleChannelOverride(c.id, sub, l)}
													/>
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						)}
					</section>

					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("settings.repliesSectionTitle")}</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							{t("settings.replyReceivedLabel")}
							<LevelSelect id={`${instanceId}-replies`} value={n.replies} onChange={handleRepliesLevel} />
						</label>
					</section>

					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("settings.strangersSectionTitle")}</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							{t("settings.strangerWantsToWriteLabel")}
							<LevelSelect id={`${instanceId}-inbox`} value={n.inbox} onChange={handleInboxLevel} />
						</label>
					</section>

					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("journal.category.moderation")}</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							{t("settings.newReportLabel")}
							<LevelSelect id={`${instanceId}-moderation-reports`} value={n.moderation.reports} onChange={handleModerationReportsLevel} />
						</label>
						<p style={{ color: "var(--muted)", background: "var(--surface)", padding: "var(--space-2xs)", borderRadius: "var(--radius)" }}>
							{t("settings.moderationAlwaysShownHint")}
						</p>
					</section>
				</div>
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("settings.mnemonicSectionTitle")}</h2>
				<MnemonicReveal ownerPubkey={ownerPubkey} hasMnemonic={hasMnemonic} />
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("settings.sessionSectionTitle")}</h2>
				<div>
					<button type="button" onClick={() => lock()}>
						{t("settings.lockNowButton")}
					</button>
				</div>
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("settings.dangerZoneTitle")}</h2>
				<DeleteAccountPanel ownerPubkey={ownerPubkey} login={currentUser.value.login} privKey={privKey} dbKey={dbKey} />
			</section>
		</Screen>
	);
}
