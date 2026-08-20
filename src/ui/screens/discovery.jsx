import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish, fetchProfiles, fetchDiscoveryProfiles } from "../signals/transport.js";
import {
	contacts,
	profiles,
	refreshContacts,
	ensureProfilesFetched,
	outgoingRequests,
	sendContactRequestAction,
	cancelContactRequestAction,
} from "../signals/contacts.js";
import { ContactIdentity } from "./contacts.jsx";
import { discoveryProfiles, refreshDiscoveryProfiles } from "../signals/discovery.js";
import { loadDiscoverySettings, publishDiscoverySettings } from "../../domain/discovery/discovery.js";
import { listOwnedChannels } from "../../domain/content/channel.js";
import Screen from "../components/screen.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// Раздел "Обзор" (этап 46, CONTRACTS.md/DESIGN.md) — публичное знакомство: тумблер
// видимости + опциональный список СВОИХ каналов сверху, карточки чужих
// discovery-broadcast'ов ("хотят познакомиться") снизу.
export default function Discovery() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;
	const instanceId = useId();

	const [settings, setSettings] = useState(null); // {visible, showChannels, channelIds}
	const [ownedChannels, setOwnedChannels] = useState([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		loadDiscoverySettings(ownerPubkey).then(setSettings);
		listOwnedChannels(ownerPubkey, dbKey).then(setOwnedChannels);

		ensureConnected(ownerPubkey, privKey, dbKey)
			.then(async () => {
				// НАЙДЕНО ЖИВЫМ E2E (этап 46): refreshContacts ОБЯЗАН завершиться ДО
				// refreshDiscoveryProfiles — иначе фильтр "скрыть уже существующих
				// контактов" читает устаревший contacts.value и только что принятый
				// контакт продолжает показываться карточкой.
				await refreshContacts();
				await fetchDiscoveryProfiles();
				await refreshDiscoveryProfiles(ownerPubkey);
				const pubkeys = discoveryProfiles.value.map((p) => p.pubkey);
				await ensureProfilesFetched(pubkeys, fetchProfiles).catch(() => {});
			})
			.catch((e) => setError(errorMessage(e)));
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

	async function handleToggleCard(pubkey) {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const alreadySent = outgoingRequests.value.some((r) => r.peerPubkey === pubkey);
			if (alreadySent) {
				await cancelContactRequestAction(pubkey);
			} else {
				await sendContactRequestAction(pubkey);
			}
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
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

			<section class="stack" style={{ "--gap": "var(--space-s)" }}>
				<h2 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("discovery.wantToMeetTitle")}</h2>
				{discoveryProfiles.value.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>{t("discovery.noOneVisible")}</p>
				) : (
					<div class="grid" style={{ "--gap": "var(--space-s)" }}>
						{discoveryProfiles.value.map((card) => {
							const sent = outgoingRequests.value.some((r) => r.peerPubkey === card.pubkey);
							return (
								<article
									key={card.pubkey}
									class="stack box"
									style={{
										"--gap": "var(--space-2xs)",
										"--pad": "var(--space-s)",
										position: "relative",
										border: "var(--border-width) solid var(--border)",
										borderRadius: "var(--radius)",
									}}
								>
									<button
										type="button"
										disabled={busy}
										onClick={() => handleToggleCard(card.pubkey)}
										aria-pressed={sent}
										aria-label={sent ? t("discovery.cancelRequestAria") : t("discovery.sendRequestAria")}
										style={{
											position: "absolute",
											top: "var(--space-2xs)",
											right: "var(--space-2xs)",
											border: "none",
											background: "none",
											padding: 0,
											cursor: "pointer",
											fontSize: "var(--step-2)",
											color: sent ? "var(--good)" : "var(--muted)",
										}}
									>
										{sent ? "✓" : "○"}
									</button>
									<ContactIdentity pubkey={card.pubkey} />
									{card.showChannels && card.channels.length > 0 && (
										<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0, "--gap": "var(--space-m)" }} class="stack">
											{card.channels.map((c) => (
												<li key={c.id}>
													<strong>{c.name}</strong>
													{c.description && <>: {c.description}</>}
												</li>
											))}
										</ul>
									)}
								</article>
							);
						})}
					</div>
				)}
			</section>
			</div>
		</Screen>
	);
}
