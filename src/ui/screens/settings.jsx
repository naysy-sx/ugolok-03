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
import Screen from "../components/screen.jsx";
import MnemonicReveal from "../components/mnemonic-reveal.jsx";

// Этап 47 — уровень уведомления как единый select (упорядоченная шкала off/badge/
// popup/sound, DESIGN.md), не 3 независимых чекбокса.
const LEVEL_LABELS = {
	off: "Выключено",
	badge: "Только счётчик",
	popup: "Всплывающее",
	sound: "Звук",
};

const DEFAULT_SENTINEL = "__default__";

// Один select для дефолта категории/подкатегории (только 4 уровня, без "по умолчанию").
function LevelSelect({ id, value, onChange, disabled }) {
	return (
		<select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value)}>
			{NOTIFICATION_LEVELS.map((level) => (
				<option key={level} value={level}>
					{LEVEL_LABELS[level]}
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
			<option value={DEFAULT_SENTINEL}>(по умолчанию)</option>
			{NOTIFICATION_LEVELS.map((level) => (
				<option key={level} value={level}>
					{LEVEL_LABELS[level]}
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
			setError(err?.message || String(err));
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
			setError("Уведомления не разрешены в браузере — проверьте настройки сайта и попробуйте снова.");
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
			<Screen title="Настройки">
				<p style={{ color: "var(--muted)" }}>Загрузка настроек…</p>
			</Screen>
		);
	}

	const n = settings.notifications;

	return (
		<Screen title="Настройки">
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<label for={`${instanceId}-scale`}>Масштаб интерфейса</label>
				<select id={`${instanceId}-scale`} value={settings.uiScale} onChange={(e) => handleScaleChange(e.currentTarget.value)}>
					{SCALE_OPTIONS.map((opt) => (
						<option key={opt.id} value={opt.id}>
							{opt.label}
						</option>
					))}
				</select>
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Акцентный цвет</h2>
				<div class="cluster" role="group" aria-label="Акцентный цвет">
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
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Язык</h2>
				<label for={`${instanceId}-language`}>Язык интерфейса</label>
				{/* Единственная опция — намеренно: в проекте нет i18n-инфраструктуры (все строки
				    зашиты по-русски), это честный список валидных значений, не фиктивный переключатель. */}
				<select id={`${instanceId}-language`} value={settings.language} disabled>
					<option value="ru">Русский</option>
				</select>
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-s)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Уведомления</h2>

				<label class="cluster" style={{ alignItems: "center" }}>
					<input type="checkbox" checked={n.enabled} onChange={(e) => handleToggleEnabled(e.currentTarget.checked)} />
					Включить уведомления
				</label>

				{n.enabled && browserPermission !== "granted" && browserPermission !== "unsupported" && (
					<p
						role="alert"
						class="cluster"
						style={{ alignItems: "center", justifyContent: "space-between", background: "var(--surface)", padding: "var(--space-2xs)", borderRadius: "var(--radius)" }}
					>
						{browserPermission === "denied"
							? "Браузер заблокировал уведомления для этого сайта — разрешите вручную в настройках сайта браузера."
							: "Браузер ещё не спрашивал разрешение на всплывающие уведомления — без него они не покажутся."}
						{browserPermission !== "denied" && (
							<button type="button" onClick={handleRequestPermission}>
								Запросить разрешение
							</button>
						)}
					</p>
				)}

				<div class="flow" style={{ "--flow-space": "var(--space-2xs)", opacity: n.enabled ? 1 : 0.5 }} inert={!n.enabled || undefined}>
					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Контакты</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							Новые запросы в контакты
							<LevelSelect id={`${instanceId}-contacts-newRequests`} value={n.contacts.newRequests} onChange={(l) => handleContactLevel("newRequests", l)} />
						</label>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							Запрос принят
							<LevelSelect id={`${instanceId}-contacts-accepted`} value={n.contacts.accepted} onChange={(l) => handleContactLevel("accepted", l)} />
						</label>
					</section>

					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Сообщения</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							По умолчанию для новых
							<LevelSelect id={`${instanceId}-messages-default`} value={n.messages.default} onChange={handleMessagesDefault} />
						</label>
						{contacts.value.length > 0 && (
							<table>
								<caption class="visually-hidden">Уведомления по каждому контакту</caption>
								<thead>
									<tr>
										<th scope="col">Контакт</th>
										<th scope="col">Уведомление</th>
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
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Каналы</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							Посты — по умолчанию
							<LevelSelect id={`${instanceId}-channels-posts`} value={n.channels.posts} onChange={(l) => handleChannelsDefault("posts", l)} />
						</label>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							Комментарии — по умолчанию
							<LevelSelect id={`${instanceId}-channels-comments`} value={n.channels.comments} onChange={(l) => handleChannelsDefault("comments", l)} />
						</label>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							Общий чат — по умолчанию
							<LevelSelect id={`${instanceId}-channels-chat`} value={n.channels.chat} onChange={(l) => handleChannelsDefault("chat", l)} />
						</label>
						{myChannels.length > 0 && (
							// Находка пользователя — список каналов пишется РОВНО ОДИН РАЗ, три
							// колонки (не три отдельных списка), CONTRACTS.md этап 47.
							<table>
								<caption class="visually-hidden">Уведомления по каждому каналу — посты/комментарии/общий чат</caption>
								<thead>
									<tr>
										<th scope="col">Канал</th>
										<th scope="col">Посты</th>
										<th scope="col">Комментарии</th>
										<th scope="col">Общий чат</th>
									</tr>
								</thead>
								<tbody>
									{myChannels.map((c) => (
										<tr key={c.id}>
											<td>{c.name || "(без названия)"}</td>
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
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Ответы</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							Кто-то ответил на мой пост/комментарий
							<LevelSelect id={`${instanceId}-replies`} value={n.replies} onChange={handleRepliesLevel} />
						</label>
					</section>

					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Заявки от незнакомцев</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							Кто-то незнакомый хочет написать вам
							<LevelSelect id={`${instanceId}-inbox`} value={n.inbox} onChange={handleInboxLevel} />
						</label>
					</section>

					<section class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Модерация</h3>
						<label class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
							Новая жалоба
							<LevelSelect id={`${instanceId}-moderation-reports`} value={n.moderation.reports} onChange={handleModerationReportsLevel} />
						</label>
						<p style={{ color: "var(--muted)", background: "var(--surface)", padding: "var(--space-2xs)", borderRadius: "var(--radius)" }}>
							Предупреждения, бан и удаление канала показываются всегда — это не настраивается.
						</p>
					</section>
				</div>
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Секретная фраза восстановления</h2>
				<MnemonicReveal ownerPubkey={ownerPubkey} hasMnemonic={hasMnemonic} />
			</section>

			<section class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>Сеанс</h2>
				<div>
					<button type="button" onClick={() => lock()}>
						Заблокировать сейчас
					</button>
				</div>
			</section>
		</Screen>
	);
}
