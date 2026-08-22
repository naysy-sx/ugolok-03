import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import { loadDiscoverySettings, publishDiscoverySettings } from "../../domain/discovery/discovery.js";
import { listOwnedChannels } from "../../domain/content/channel.js";
import Screen from "../components/screen.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// Раздел "Обзор" (этап 46, CONTRACTS.md/DESIGN.md) — публичное знакомство:
// тумблер видимости + опциональный список СВОИХ каналов.
// Редизайн интерфейса, этап 7 (CONTRACTS.md) — грид карточек "Хотят
// познакомиться" (чужие discovery-broadcast'ы) переехал на экран "Люди"
// (contacts.jsx) целиком, вместе с сигналами discoveryProfiles/
// refreshDiscoveryProfiles (теперь в signals/contacts.js) и вызовом
// fetchDiscoveryProfiles. Здесь остаётся только СОБСТВЕННАЯ видимость —
// эффект больше не требует сети (ensureConnected/refreshContacts/
// fetchDiscoveryProfiles/ensureProfilesFetched были нужны исключительно
// ради удалённого грида): loadDiscoverySettings/listOwnedChannels — оба
// чисто локальные Dexie-чтения. publish работает без предварительного
// ensureConnected в этом файле — прецедент settings.jsx (глобальное
// соединение через ConnectionStatusPanel, app.jsx, не per-screen).
export default function Discovery() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;
	const instanceId = useId();

	const [settings, setSettings] = useState(null); // {visible, showChannels, channelIds}
	const [ownedChannels, setOwnedChannels] = useState([]);
	const [error, setError] = useState("");

	useEffect(() => {
		loadDiscoverySettings(ownerPubkey).then(setSettings);
		listOwnedChannels(ownerPubkey, dbKey).then(setOwnedChannels);
	}, [ownerPubkey]);

	async function persist(next) {
		setSettings(next);
		try {
			await publishDiscoverySettings(ownerPubkey, privKey, dbKey, next, publish);
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	function handleVisibleToggle(checked) {
		if (!checked) {
			// Скрыть — сразу, без промежуточного "OK" (симметрично тому, что показ
			// каналов/выбор каналов подтверждаются явно, а спрятаться можно немедленно).
			persist({ ...settings, visible: false });
		} else {
			// Показать — только раскрывает панель настроек ниже, публикация — по "OK"
			// (пользовательское описание раздела, CONTRACTS.md этап 46).
			setSettings({ ...settings, visible: true });
		}
	}

	function toggleChannelId(channelId) {
		setSettings((prev) => {
			const has = prev.channelIds.includes(channelId);
			return { ...prev, channelIds: has ? prev.channelIds.filter((id) => id !== channelId) : [...prev.channelIds, channelId] };
		});
	}

	if (!settings) {
		return (
			<Screen title={t("nav.discovery")}>
				<p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>
			</Screen>
		);
	}

	return (
		<Screen title={t("nav.discovery")}>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
				{error && (
					<p role="alert" style={{ color: "var(--bad)" }}>
						{error}
					</p>
				)}

				<section class="stack" style={{ "--gap": "var(--space-2xs)" }}>
					<label class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
						<input type="checkbox" checked={settings.visible} onChange={(e) => handleVisibleToggle(e.currentTarget.checked)} />
						{t("discovery.showMeToggle")}
					</label>

					{settings.visible && (
						<div class="stack" style={{ "--gap": "var(--space-2xs)", marginInlineStart: "var(--space-m)" }}>
							<label class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
								<input
									type="checkbox"
									checked={settings.showChannels}
									onChange={(e) => setSettings({ ...settings, showChannels: e.currentTarget.checked })}
								/>
								{t("discovery.showChannelsToggle")}
							</label>

							{settings.showChannels && (
								<fieldset class="stack" style={{ "--gap": "var(--space-3xs)", border: "none", padding: 0 }}>
									<legend>{t("discovery.whichChannelsLegend")}</legend>
									{ownedChannels.length === 0 ? (
										<p style={{ color: "var(--muted)" }}>{t("discovery.noOwnChannels")}</p>
									) : (
										ownedChannels.map((c) => (
											<label key={c.id} class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
												<input
													id={`${instanceId}-ch-${c.id}`}
													type="checkbox"
													checked={settings.channelIds.includes(c.id)}
													onChange={() => toggleChannelId(c.id)}
												/>
												{c.name}
											</label>
										))
									)}
								</fieldset>
							)}

							<div>
								<button type="button" onClick={() => persist(settings)}>
									OK
								</button>
							</div>
						</div>
					)}
				</section>
			</div>
		</Screen>
	);
}
