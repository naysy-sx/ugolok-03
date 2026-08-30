import { useState, useEffect, useRef, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish, fetchProfiles, fetchDiscoveryProfiles } from "../signals/transport.js";
import { discoveryProfiles, refreshDiscoveryProfiles, outgoingRequests, ensureProfilesFresh, sendContactRequestAction, cancelContactRequestAction, ownDiscoveryVisible } from "../signals/contacts.js";
import { getProfile } from "../../core/crypto/keystore.js";
import { loadDiscoverySettings, publishDiscoverySettings, markDiscoveryExpired, DISCOVERY_DURATIONS } from "../../domain/discovery/discovery.js";
import { isClean } from "../../domain/discovery/wordfilter.js";
import stopwords from "../../domain/discovery/stopwords.json" with { type: "json" };
import { reportDiscoveryProfile, hideDiscoveryProfileLocally } from "../../domain/discovery/reports.js";
import { writeJournalEntry } from "../../domain/notifications/journal.js";
import { listOwnedChannels } from "../../domain/content/channel.js";
import { BUILD_ADMIN_PUBKEY } from "../../config.js";
import { ContactIdentity } from "./contacts.jsx";
import Screen from "../components/screen.jsx";
import IconEye from "../icons/eye.jsx";
import IconFlag from "../icons/flag.jsx";
import { pushToast } from "../signals/toasts.js";
import { t, errorMessage } from "../signals/i18n.js";

// CONTRACTS.md §DISCOVERY, T4 — часы:минуты когда осталось больше часа,
// иначе минуты:секунды. Числовой формат без плюрализации — не нуждается
// в переводе на 12 локалей (тот же приём, что выбор длительности ниже).
function formatCountdown(remainingSeconds) {
	const total = Math.max(0, Math.round(remainingSeconds));
	if (total >= 3600) {
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		return `${hours}:${String(minutes).padStart(2, "0")}`;
	}
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// CONTRACTS.md §DISCOVERY, T5 — переехало из profile.jsx целиком (было
// вырезано этим же этапом). Устранена ловушка исходной версии: включение
// теперь публикует СРАЗУ (длительность выбирается ДО включения), а не
// только раскрывает панель до отдельного "Сохранить" — человек больше не
// может поставить галочку, уйти и не опубликовать ничего.
function VisibilitySection({ ownerPubkey, privKey, dbKey }) {
	const instanceId = useId();
	const [settings, setSettings] = useState(null); // {visible, showChannels, channelIds, visibleUntil}
	const [ownedChannels, setOwnedChannels] = useState([]);
	const [error, setError] = useState("");
	const [selectedDuration, setSelectedDuration] = useState(DISCOVERY_DURATIONS[0]);
	const [previewBio, setPreviewBio] = useState("");
	const [previewAvatarUrl, setPreviewAvatarUrl] = useState("");
	// tick — форсирует пересчёт remainingSeconds раз в 30с (секундная точность
	// для окна 10мин/1ч/сутки избыточна, лишние ре-рендеры не нужны).
	const [tick, setTick] = useState(0);

	useEffect(() => {
		loadDiscoverySettings(ownerPubkey).then(setSettings);
		listOwnedChannels(ownerPubkey, dbKey).then(setOwnedChannels);
		getProfile(ownerPubkey)
			.then((p) => {
				setPreviewBio(p.bio);
				setPreviewAvatarUrl(p.avatar || p.avatarUrl || "");
			})
			.catch(() => {});
	}, [ownerPubkey]);

	useEffect(() => {
		const id = setInterval(() => setTick((v) => v + 1), 30000);
		return () => clearInterval(id);
	}, []);

	// CONTRACTS.md §DISCOVERY — живой фидбек пользователя: тихая настройка
	// незаметно оставалась включённой. Глобальный сигнал держится в
	// contacts.js (читает nav-groups.jsx на любом экране), синхронизируется
	// с КАЖДЫМ изменением settings, а не только с явными действиями ниже —
	// один источник истины, а не дублирование в каждом обработчике.
	useEffect(() => {
		if (settings) ownDiscoveryVisible.value = settings.visible;
	}, [settings]);

	// Автоистечение: и на монтировании (если visibleUntil уже в прошлом), и на
	// каждый тик. Публикация НЕ нужна (expiration+фильтр читателя уже прячут
	// карточку) — только локальный флаг, чтобы переключатель у владельца не
	// показывал "включено" после срока. Живой фидбек пользователя — истечение
	// обязано быть заметным (тост) и оставлять след (запись в журнале), не
	// просто тихо гаснуть.
	useEffect(() => {
		if (settings && settings.visible && settings.visibleUntil <= Math.floor(Date.now() / 1000)) {
			markDiscoveryExpired(ownerPubkey).then(() => {
				setSettings((prev) => (prev ? { ...prev, visible: false } : prev));
				pushToast({ title: t("discovery.expiredToastTitle") });
				writeJournalEntry(ownerPubkey, dbKey, {
					category: "discovery",
					titleKey: "discovery.expiredToastTitle",
					navTarget: { screen: "discovery" },
					occurredAt: Date.now(),
				}).catch(() => {});
			});
		}
	}, [settings, tick, ownerPubkey, dbKey]);

	async function persist(next) {
		setSettings(next);
		try {
			await ensureConnected(ownerPubkey, privKey, dbKey);
			await publishDiscoverySettings(ownerPubkey, privKey, dbKey, next, publish);
			pushToast({ title: t("profile.savedStatus") });
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	function handleVisibleToggle(checked) {
		if (!checked) {
			persist({ ...settings, visible: false });
		} else {
			const visibleUntil = Math.floor(Date.now() / 1000) + selectedDuration;
			persist({ ...settings, visible: true, visibleUntil });
		}
	}

	function toggleChannelId(channelId) {
		setSettings((prev) => {
			const has = prev.channelIds.includes(channelId);
			return { ...prev, channelIds: has ? prev.channelIds.filter((id) => id !== channelId) : [...prev.channelIds, channelId] };
		});
	}

	if (!settings) return null;

	const remainingSeconds = settings.visibleUntil - Math.floor(Date.now() / 1000);
	const previewName = currentUser.value.login;
	const previewChannels = settings.showChannels ? ownedChannels.filter((c) => settings.channelIds.includes(c.id)) : [];

	// CONTRACTS.md §DISCOVERY, T8 — предупреждение, НЕ блокировка: реальная
	// защита — реле (write-policy плагин) + читатель (refreshDiscoveryProfiles),
	// это только удобство, "этот текст не пройдёт".
	const dirtyFields = [];
	if (previewBio && !isClean(previewBio, stopwords)) dirtyFields.push(t("discovery.fieldBio"));
	for (const c of previewChannels) {
		if (!isClean(c.name, stopwords) || !isClean(c.description, stopwords)) dirtyFields.push(c.name);
	}

	return (
		<section class={"panel stack" + (settings.visible ? " panel--good" : "")} style={{ "--gap": "var(--space-m)" }}>
			<div class="panel__head stack" style={{ "--gap": "var(--space-3xs)" }}>
				<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					<IconEye />
					{t("discovery.visibilityTitle")}
				</h2>
				<p class="panel__hint">{t("discovery.visibilityHint")}</p>
			</div>

			{/* Живой фидбек пользователя — статус видимости должен быть первым, что
			    видно после заголовка, не погребён ниже переключателя каналов. */}
			{settings.visible && (
				<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
					<span>{t("discovery.timeRemainingLabel", { time: formatCountdown(remainingSeconds) })}</span>
					<button type="button" class="rigid" onClick={() => persist({ ...settings, visible: false })}>
						{t("discovery.hideNowButton")}
					</button>
				</div>
			)}

			{error && (
				<p role="alert" class="callout callout--bad">
					{error}
				</p>
			)}

			<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
				<input
					type="checkbox"
					class="set-row__switch"
					checked={settings.visible}
					onChange={(e) => handleVisibleToggle(e.currentTarget.checked)}
					style={{ inlineSize: "1.7rem", blockSize: "1.7rem" }}
				/>
				<span class="set-row__text">{t("discovery.showMeToggle")}</span>
			</label>

			{!settings.visible && (
				<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
					<span class="panel__hint">{t("discovery.durationLegend")}</span>
					<div class="seg bar rigid" style={{ "--gap": 0 }} role="group" aria-label={t("discovery.durationPickerAria")}>
						{DISCOVERY_DURATIONS.map((duration, i) => {
							const labelKey = ["discovery.duration10m", "discovery.duration1h", "discovery.duration1d"][i];
							return (
								<button
									key={duration}
									type="button"
									class={"slice bar rigid" + (selectedDuration === duration ? " slice--on" : "")}
									aria-pressed={selectedDuration === duration}
									onClick={() => setSelectedDuration(duration)}
								>
									{t(labelKey)}
								</button>
							);
						})}
					</div>
				</div>
			)}

			{dirtyFields.length > 0 && (
				<p role="alert" class="callout callout--bad">
					{t("discovery.moderationWarning", { fields: dirtyFields.join(", ") })}
				</p>
			)}

			<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
				<span class="panel__hint">{t("discovery.previewTitle")}</span>
				<article
					class="stack box"
					style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)", position: "relative", border: "var(--border-width) solid var(--border)", borderRadius: "var(--radius)" }}
				>
					<div class="contact-identity row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						{previewAvatarUrl ? (
							<img src={previewAvatarUrl} alt="" width="40" height="40" class="contact-avatar" />
						) : (
							<div aria-hidden="true" class="contact-avatar contact-avatar-fallback row" style={{ "--align": "center", justifyContent: "center" }}>
								{(previewName || "?").trim().charAt(0).toUpperCase()}
							</div>
						)}
						<span class="stack" style={{ "--gap": "var(--space-3xs)" }}>
							<span>{previewName}</span>
							{previewBio && <small>{previewBio}</small>}
						</span>
					</div>
					{settings.showChannels && previewChannels.length > 0 && (
						<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0, "--gap": "var(--space-m)" }} class="stack">
							{previewChannels.map((c) => (
								<li key={c.id}>
									<strong>{c.name}</strong>
									{c.description && <>: {c.description}</>}
								</li>
							))}
						</ul>
					)}
				</article>
			</div>

			{/* Вложенность больше НЕ передаётся отступом слева (был инлайновый
			    marginInlineStart — margin на компоненте, REGLAMENT.md §3 п.1).
			    Зависимые настройки просто идут следом: включённый верхний
			    переключатель и так их показывает, а выключенный — скрывает. */}
			{settings.visible && (
				<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
					<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
						<input
							type="checkbox"
							class="set-row__switch"
							checked={settings.showChannels}
							onChange={(e) => setSettings({ ...settings, showChannels: e.currentTarget.checked })}
							style={{ inlineSize: "1.7rem", blockSize: "1.7rem" }}
						/>
						<span class="set-row__text">{t("discovery.showChannelsToggle")}</span>
					</label>

					{settings.showChannels && (
						<fieldset
							class="stack"
							style={{ "--gap": "var(--space-s)", borderInlineStart: "none", borderInlineEnd: "none", borderBlockEnd: "none", paddingInline: 0, paddingBlockEnd: 0 }}
						>
							{/* border-block-start/padding-block-start НЕ обнуляем (в отличие от
							    остальных сторон) — это тот самый разделитель, который рисует
							    .set-list > * + * родителя (fieldset — второй ребёнок .set-list
							    выше). Обнулить их инлайном значило бы молча погасить чужой
							    разделитель, найдено при живой проверке пользователем. */}
							<legend class="sect-title">{t("discovery.whichChannelsLegend")}</legend>
							{ownedChannels.length === 0 ? (
								<p class="panel__hint">{t("discovery.noOwnChannels")}</p>
							) : (
								<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
									{ownedChannels.map((c) => (
										<label key={c.id} class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
											<span class="set-row__text">{c.name}</span>
											<input
												id={`${instanceId}-ch-${c.id}`}
												type="checkbox"
												class="set-row__switch"
												checked={settings.channelIds.includes(c.id)}
												onChange={() => toggleChannelId(c.id)}
											/>
										</label>
									))}
								</div>
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
}

// ASIDE-REDESIGN/SIDEBAR-SPEC-2.md, этап 4 — «Знакомства» переехало из
// contacts.jsx (там жило секцией renderDiscoverySection, с комментарием
// "переехало из discovery.jsx" — этап 7/49, полный круг) в отдельный
// экран: первая строка списка панели (nav-groups.jsx) ведёт сюда
// напрямую, не через "Контакты". busy/rowError — своё состояние экрана,
// НЕ общее с Contacts (тот делит его между добавлением/группами/блоками
// — здесь только один вид действия, отдельный gate не усложняет).
export default function Discovery() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;

	const [connectionError, setConnectionError] = useState("");
	const [busy, setBusy] = useState(false);
	// busyRef — та же синхронная защита от повторного входа, что в contacts.jsx
	// (busy-state коммитится асинхронно, второй клик до коммита не увидел бы его).
	const busyRef = useRef(false);

	useEffect(() => {
		ensureConnected(ownerPubkey, privKey, dbKey)
			.then(async () => {
				await fetchDiscoveryProfiles();
				await refreshDiscoveryProfiles(ownerPubkey);
				const discoveryPubkeys = discoveryProfiles.value.map((p) => p.pubkey);
				await ensureProfilesFresh(discoveryPubkeys, fetchProfiles, { force: true });
			})
			.catch((e) => setConnectionError(errorMessage(e)));
	}, [ownerPubkey]);

	// Живой фидбек пользователя — было ○/✓ без подписи ("непонятная галочка"),
	// теперь настоящая кнопка с текстом состояния + тост на исход (успех/
	// отмена/провал), не молчаливое переключение символа.
	async function handleToggleDiscoveryCard(pubkey) {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		try {
			const alreadySent = outgoingRequests.value.some((r) => r.peerPubkey === pubkey);
			await (alreadySent ? cancelContactRequestAction(pubkey) : sendContactRequestAction(pubkey));
			pushToast({ title: alreadySent ? t("discovery.requestCancelledToast") : t("discovery.requestSentButton") });
		} catch (err) {
			pushToast({ title: t("discovery.requestFailedToast"), body: errorMessage(err) });
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	// CONTRACTS.md §DISCOVERY, T9 — 1-в-1 с ModerationActions.handleReport
	// (moderation-actions.jsx), отличия — адресат (admin, не владелец канала)
	// и локальное скрытие СРАЗУ, независимо от исхода publish (ТЗ: "немедленно
	// и навсегда, независимо от того, ушла ли жалоба в сеть").
	async function handleReportCard(card) {
		const reason = window.prompt(t("moderation.reportPromptMessage"), "");
		if (reason === null) return; // отмена
		await hideDiscoveryProfileLocally(ownerPubkey, card.pubkey);
		discoveryProfiles.value = discoveryProfiles.value.filter((p) => p.pubkey !== card.pubkey);
		try {
			await reportDiscoveryProfile(
				privKey,
				BUILD_ADMIN_PUBKEY,
				{ targetPubkey: card.pubkey, reason: reason || "report", snapshot: { bio: card.bio, showChannels: card.showChannels, channels: card.channels } },
				publish,
			);
			pushToast({ title: t("moderation.reportSentToast") });
		} catch (err) {
			pushToast({ title: t("moderation.reportFailedToast"), body: errorMessage(err) });
		}
	}

	return (
		<Screen title={t("shell.discoverHeading")}>
			{connectionError && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{connectionError}
				</p>
			)}

			<VisibilitySection ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} />

			<section class="stack" aria-labelledby="discovery-heading" style={{ "--gap": "var(--space-s)" }}>
				<h2 id="discovery-heading" style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>
					{t("discovery.wantToMeetTitle")}
				</h2>
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
									{BUILD_ADMIN_PUBKEY && (
										<button
											type="button"
											onClick={() => handleReportCard(card)}
											aria-label={t("discovery.reportButtonAria")}
											title={t("moderation.reportButton")}
											style={{
												position: "absolute",
												top: "var(--space-2xs)",
												right: "var(--space-2xs)",
												border: "none",
												background: "none",
												padding: 0,
												cursor: "pointer",
												fontSize: "var(--step-1)",
												color: "var(--muted)",
											}}
										>
											<IconFlag />
										</button>
									)}
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
									{/* Живой фидбек пользователя — было ○/✓ без подписи, никто не понимал,
									    что это значит. Настоящая кнопка с текстом состояния. */}
									<div class="row">
										<button type="button" class="rigid" disabled={busy} onClick={() => handleToggleDiscoveryCard(card.pubkey)} aria-pressed={sent}>
											{sent ? t("discovery.requestSentButton") : t("discovery.sendRequestButton")}
										</button>
									</div>
								</article>
							);
						})}
					</div>
				)}
			</section>
		</Screen>
	);
}
