import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, lock } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import { loadUiSettings, saveUiSettings } from "../../domain/settings/ui-settings.js";
import { requestNotificationPermission } from "../../domain/notifications/notifier.js";
import { listAccounts } from "../../core/crypto/keystore.js";
import { ACCENT_COLORS, applyAccentColor } from "../theme/accent-palette.js";
import { SCALE_OPTIONS, applyUiScale } from "../theme/ui-scale.js";
import Screen from "../components/screen.jsx";
import MnemonicReveal from "../components/mnemonic-reveal.jsx";

// Мокап пользователя (v0.1, https://ibb.co/WWQNbYJ6) — раздел "Приватность" вне
// скоупа (решение пользователя, CONTRACTS.md/этап 34): presence-протокол и поиск
// пользователей не существуют в архитектуре проекта, это отдельная будущая фича.
export default function Settings() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;

	const [settings, setSettings] = useState(null);
	const [error, setError] = useState("");
	const [hasMnemonic, setHasMnemonic] = useState(false);
	const instanceId = useId();

	useEffect(() => {
		loadUiSettings(ownerPubkey).then((loaded) => {
			setSettings(loaded);
			applyAccentColor(loaded.accentColorId);
			applyUiScale(loaded.uiScale);
		});
		listAccounts().then((accounts) => {
			setHasMnemonic(!!accounts.find((a) => a.id === ownerPubkey)?.hasMnemonic);
		});
	}, [ownerPubkey]);

	async function persist(next) {
		setSettings(next);
		try {
			await saveUiSettings(ownerPubkey, privKey, next, publish);
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
			const permission = await requestNotificationPermission();
			if (permission !== "granted") {
				setError("Уведомления не разрешены в браузере — проверьте настройки сайта и попробуйте снова.");
			}
		}
		persist({ ...settings, notifications: { ...settings.notifications, enabled: checked } });
	}

	function handleToggleSound(checked) {
		persist({ ...settings, notifications: { ...settings.notifications, sound: checked } });
	}

	function handleToggleCategory(category, checked) {
		persist({
			...settings,
			notifications: { ...settings.notifications, [category]: { ...settings.notifications[category], enabled: checked } },
		});
	}

	function handleToggleSub(category, field, checked) {
		persist({
			...settings,
			notifications: { ...settings.notifications, [category]: { ...settings.notifications[category], [field]: checked } },
		});
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
				<label class="cluster" style={{ alignItems: "center" }}>
					<input type="checkbox" checked={n.sound} onChange={(e) => handleToggleSound(e.currentTarget.checked)} disabled={!n.enabled} />
					Звуковое оповещение
				</label>

				<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
					<label class="cluster" style={{ alignItems: "center" }}>
						<input
							type="checkbox"
							checked={n.contacts.enabled}
							onChange={(e) => handleToggleCategory("contacts", e.currentTarget.checked)}
							disabled={!n.enabled}
						/>
						Контакты
					</label>
					<div class="flow" style={{ "--flow-space": "var(--space-3xs)", marginInlineStart: "var(--space-m)" }}>
						<label class="cluster" style={{ alignItems: "center" }}>
							<input
								type="checkbox"
								checked={n.contacts.newRequests}
								onChange={(e) => handleToggleSub("contacts", "newRequests", e.currentTarget.checked)}
								disabled={!n.enabled || !n.contacts.enabled}
							/>
							Новые запросы в контакты
						</label>
						<label class="cluster" style={{ alignItems: "center" }}>
							<input
								type="checkbox"
								checked={n.contacts.accepted}
								onChange={(e) => handleToggleSub("contacts", "accepted", e.currentTarget.checked)}
								disabled={!n.enabled || !n.contacts.enabled}
							/>
							Запрос принят
						</label>
					</div>
				</div>

				<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
					<label class="cluster" style={{ alignItems: "center" }}>
						<input
							type="checkbox"
							checked={n.messages.enabled}
							onChange={(e) => handleToggleCategory("messages", e.currentTarget.checked)}
							disabled={!n.enabled}
						/>
						Сообщения
					</label>
					<div class="flow" style={{ "--flow-space": "var(--space-3xs)", marginInlineStart: "var(--space-m)" }}>
						<label class="cluster" style={{ alignItems: "center" }}>
							<input
								type="checkbox"
								checked={n.messages.incoming}
								onChange={(e) => handleToggleSub("messages", "incoming", e.currentTarget.checked)}
								disabled={!n.enabled || !n.messages.enabled}
							/>
							Входящие сообщения
						</label>
					</div>
				</div>

				<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
					<label class="cluster" style={{ alignItems: "center" }}>
						<input
							type="checkbox"
							checked={n.channels.enabled}
							onChange={(e) => handleToggleCategory("channels", e.currentTarget.checked)}
							disabled={!n.enabled}
						/>
						Каналы
					</label>
					<div class="flow" style={{ "--flow-space": "var(--space-3xs)", marginInlineStart: "var(--space-m)" }}>
						<label class="cluster" style={{ alignItems: "center" }}>
							<input
								type="checkbox"
								checked={n.channels.newPosts}
								onChange={(e) => handleToggleSub("channels", "newPosts", e.currentTarget.checked)}
								disabled={!n.enabled || !n.channels.enabled}
							/>
							Новые посты
						</label>
						<label class="cluster" style={{ alignItems: "center" }}>
							<input
								type="checkbox"
								checked={n.channels.chatMessages}
								onChange={(e) => handleToggleSub("channels", "chatMessages", e.currentTarget.checked)}
								disabled={!n.enabled || !n.channels.enabled}
							/>
							Сообщения в чате канала
						</label>
					</div>
				</div>

				<p style={{ color: "var(--muted)", background: "var(--surface)", padding: "var(--space-2xs)", borderRadius: "var(--radius)" }}>
					Предупреждения, бан и удаление канала показываются всегда.
				</p>
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
