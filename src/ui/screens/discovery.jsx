import { useState, useEffect, useRef, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish, fetchProfiles, fetchDiscoveryProfiles, refreshLiveDiscoverySubscription } from "../signals/transport.js";
import { discoveryProfiles, refreshDiscoveryProfiles, outgoingRequests, ensureProfilesFresh, sendContactRequestAction, cancelContactRequestAction, ownDiscoveryVisible, profiles } from "../signals/contacts.js";
import { shortPubkey } from "../format.js";
import { getProfile } from "../../core/crypto/keystore.js";
import { loadDiscoverySettings, publishDiscoverySettings, markDiscoveryExpired, DISCOVERY_DURATIONS } from "../../domain/discovery/discovery.js";
import { isClean } from "../../domain/discovery/wordfilter.js";
import stopwords from "../../domain/discovery/stopwords.json" with { type: "json" };
import { reportDiscoveryProfile, hideDiscoveryProfileLocally } from "../../domain/discovery/reports.js";
import { writeJournalEntry } from "../../domain/notifications/journal.js";
import { listOwnedChannels, countChannelReaders } from "../../domain/content/channel.js";
import { BUILD_ADMIN_PUBKEY } from "../../config.js";
import { ContactIdentity } from "./contacts.jsx";
import Screen from "../components/screen.jsx";
import ActionsMenu from "../components/actions-menu.jsx";
import IconEye from "../icons/eye.jsx";
import { pushToast } from "../signals/toasts.js";
import { t, errorMessage } from "../signals/i18n.js";

function nowSec() {
	return Math.floor(Date.now() / 1000);
}

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

const DURATION_LABEL_KEYS = ["discovery.duration10m", "discovery.duration1h", "discovery.duration1d"];
const RING_CIRCUMFERENCE = 2 * Math.PI * 19;

// CONTRACTS.md §DISCOVERY-REDESIGN, §3 — переписан целиком под три состояния
// (выключено/сборка/трансляция) вместо тумблера+раскрывающихся блоков T5/T9.
// Один и тот же .panel (+.panel--good когда settings.visible) на всех трёх —
// не заводим новый декоративный класс "лампа" из макета-референса (ТЗ §0:
// макет описывает композицию/поведение, не разметку). До нажатия первичной
// кнопки в "сборке" НЕ публикуется ничего — черновик живёт в draft, settings
// не трогается, пока не вызван persist().
function VisibilitySection({ ownerPubkey, privKey, dbKey }) {
	const instanceId = useId();
	const [settings, setSettings] = useState(null); // {visible, showChannels, channelIds, showBio, showRules, visibleUntil}
	const [ownedChannels, setOwnedChannels] = useState([]);
	const [readersByChannel, setReadersByChannel] = useState({});
	const [error, setError] = useState("");
	const [isComposing, setIsComposing] = useState(false);
	const [draft, setDraft] = useState(null); // {channelIds, showBio, showRules} — черновик состояния 2
	const [selectedDuration, setSelectedDuration] = useState(DISCOVERY_DURATIONS[0]);
	const [previewBio, setPreviewBio] = useState("");
	const [previewAvatarUrl, setPreviewAvatarUrl] = useState("");
	// tick — форсирует пересчёт remainingSeconds раз в 30с (секундная точность
	// для окна 10мин/1ч/сутки избыточна, лишние ре-рендеры не нужны).
	const [tick, setTick] = useState(0);

	useEffect(() => {
		loadDiscoverySettings(ownerPubkey).then((s) => {
			setSettings(s);
			// CONTRACTS.md §DISCOVERY-REDESIGN, Э6 — холодная загрузка экрана ВО
			// ВРЕМЯ уже идущей трансляции: selectedDuration (нужен "Продлить" и
			// кольцу остатка) не хранится в схеме. Эвристика — ближайший СВЕРХУ
			// тариф длительности под остаток, не дефолт 10 минут вслепую.
			if (s.visible) {
				const remaining = s.visibleUntil - nowSec();
				const closest = DISCOVERY_DURATIONS.find((d) => d >= remaining) ?? DISCOVERY_DURATIONS[DISCOVERY_DURATIONS.length - 1];
				setSelectedDuration(closest);
			}
		});
		listOwnedChannels(ownerPubkey, dbKey).then(async (channels) => {
			setOwnedChannels(channels);
			const counts = {};
			for (const c of channels) {
				counts[c.id] = await countChannelReaders(ownerPubkey, c.id);
			}
			setReadersByChannel(counts);
		});
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
		if (settings && settings.visible && settings.visibleUntil <= nowSec()) {
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

	function openCompose() {
		setDraft({ channelIds: settings.channelIds, showBio: settings.showBio, showRules: settings.showRules });
		setIsComposing(true);
	}

	function closeCompose() {
		setIsComposing(false);
		setDraft(null);
	}

	function toggleDraftChannel(channelId) {
		setDraft((prev) => {
			const has = prev.channelIds.includes(channelId);
			return { ...prev, channelIds: has ? prev.channelIds.filter((id) => id !== channelId) : [...prev.channelIds, channelId] };
		});
	}

	// Первичная кнопка сборки — единственное место, где "сборка" превращается
	// в публикацию. showChannels производный (D10) — отдельного React state
	// для него больше нет, макро-тумблер убран из интерфейса целиком.
	async function handlePublish() {
		const visibleUntil = nowSec() + selectedDuration;
		await persist({
			visible: true,
			showChannels: draft.channelIds.length > 0,
			channelIds: draft.channelIds,
			showBio: draft.showBio,
			showRules: draft.showRules,
			visibleUntil,
		});
		closeCompose();
	}

	async function handleExtend() {
		await persist({ ...settings, visible: true, visibleUntil: nowSec() + selectedDuration });
	}

	async function handleHideNow() {
		await persist({ ...settings, visible: false });
	}

	if (!settings) return null;

	const remainingSeconds = settings.visibleUntil - nowSec();
	const previewName = currentUser.value.login;

	if (!isComposing) {
		if (!settings.visible) {
			// Состояние 1 — выключено, свёрнуто.
			return (
				<section id="discovery-visibility" class="panel stack" style={{ "--gap": "var(--space-m)" }}>
					<div class="bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						<div class="stack grow" style={{ "--gap": "var(--space-3xs)" }}>
							<h2 class="panel__title bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
								<IconEye />
								{t("discovery.hiddenTitle")}
							</h2>
							<p class="panel__hint">{t("discovery.hiddenHint")}</p>
						</div>
						<button type="button" class="rigid" onClick={openCompose}>
							{t("discovery.showSelfButton")}
						</button>
					</div>
					{error && (
						<p role="alert" class="callout callout--bad">
							{error}
						</p>
					)}
				</section>
			);
		}

		// Состояние 3 — идёт трансляция, свёрнуто.
		const liveChannels = ownedChannels.filter((c) => settings.channelIds.includes(c.id));
		const summaryParts = [t("discovery.summaryNick"), t("discovery.summaryAvatar")];
		if (settings.showBio) summaryParts.push(t("discovery.summaryBioPart"));
		const p = Math.max(0, Math.min(1, selectedDuration > 0 ? remainingSeconds / selectedDuration : 0));

		return (
			<section id="discovery-visibility" class="panel panel--good stack" style={{ "--gap": "var(--space-m)" }}>
				<div class="bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
					<svg class="ring rigid" width="44" height="44" viewBox="0 0 44 44" style={{ "--circ": RING_CIRCUMFERENCE, "--p": p }} aria-hidden="true">
						<circle class="track" cx="22" cy="22" r="19" />
						<circle class="live" cx="22" cy="22" r="19" />
					</svg>
					<div class="stack grow" style={{ "--gap": "var(--space-3xs)" }}>
						<h2 class="panel__title">{t("discovery.visibleTitle", { time: formatCountdown(remainingSeconds) })}</h2>
						<p class="panel__hint">
							{liveChannels.length > 0
								? t("discovery.visibleHint", { parts: summaryParts.join(", "), names: liveChannels.map((c) => c.name).join(", ") })
								: t("discovery.visibleHintNoChannels", { parts: summaryParts.join(", ") })}
						</p>
					</div>
					<div class="bar rigid" style={{ "--gap": "var(--space-2xs)" }}>
						<button type="button" onClick={handleExtend}>
							{t("discovery.extendButton")}
						</button>
						<button type="button" onClick={openCompose}>
							{t("discovery.editButton")}
						</button>
						<button type="button" onClick={handleHideNow}>
							{t("discovery.hideNowButton")}
						</button>
					</div>
				</div>
				{error && (
					<p role="alert" class="callout callout--bad">
						{error}
					</p>
				)}
			</section>
		);
	}

	// Состояние 2 — сборка трансляции (раскрыто из состояния 1 или 3).
	const draftChannels = ownedChannels.filter((c) => draft.channelIds.includes(c.id));
	const soloSelected = draftChannels.filter((c) => (readersByChannel[c.id] ?? 0) === 0);

	// CONTRACTS.md §DISCOVERY, T8 — предупреждение, НЕ блокировка: реальная
	// защита — реле (write-policy плагин) + читатель (refreshDiscoveryProfiles),
	// это только удобство, "этот текст не пройдёт". Покрывает и rules (Э2/D9),
	// если общий переключатель правил включён.
	const dirtyFields = [];
	if (draft.showBio && previewBio && !isClean(previewBio, stopwords)) dirtyFields.push(t("discovery.fieldBio"));
	for (const c of draftChannels) {
		const rulesDirty = draft.showRules && c.rules && !isClean(c.rules, stopwords);
		if (!isClean(c.name, stopwords) || !isClean(c.description, stopwords) || rulesDirty) dirtyFields.push(c.name);
	}

	const summaryParts = [t("discovery.summaryNick"), t("discovery.summaryAvatar")];
	if (draft.showBio) summaryParts.push(t("discovery.summaryBioPart"));
	summaryParts.push(draftChannels.length > 0 ? t("discovery.summaryChannelsPart", { count: draftChannels.length }) : t("discovery.summaryNoChannelsPart"));
	const durationIndex = DISCOVERY_DURATIONS.indexOf(selectedDuration);
	const durationLabelKey = DURATION_LABEL_KEYS[durationIndex] ?? DURATION_LABEL_KEYS[0];

	return (
		<section id="discovery-visibility" class={"panel stack" + (settings.visible ? " panel--good" : "")} style={{ "--gap": "var(--space-m)" }}>
			<div class="bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<h2 class="panel__title grow">{t("discovery.composeTitle")}</h2>
				<button type="button" class="rigid" onClick={closeCompose} aria-label={t("common.cancel")}>
					✕
				</button>
			</div>

			<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
				<span class="panel__hint">{t("discovery.durationLegend")}</span>
				<div class="seg bar rigid" style={{ "--gap": 0 }} role="group" aria-label={t("discovery.durationPickerAria")}>
					{DISCOVERY_DURATIONS.map((duration, i) => (
						<button
							key={duration}
							type="button"
							class={"slice bar rigid" + (selectedDuration === duration ? " slice--on" : "")}
							aria-pressed={selectedDuration === duration}
							onClick={() => setSelectedDuration(duration)}
						>
							{t(DURATION_LABEL_KEYS[i])}
						</button>
					))}
				</div>
			</div>

			<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
				<span class="panel__hint">{t("discovery.previewTitle")}</span>
				<article
					class="stack box contact-info--decorated"
					style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)", border: "var(--border-width) solid var(--border)", borderRadius: "var(--radius)" }}
				>
					{/* --align: flex-start, не center — эта колонка, в отличие от
					    9 остальных мест ContactIdentity, реально растёт (био +
					    список каналов может стать заметно выше аватара), центр
					    заставил бы аватар "плавать" посреди высокого блока
					    (CONTRACTS.md §DISCOVERY-REDESIGN, довесок). Фигура +
					    decorated-панель — тот же словарь классов, что
					    ContactIdentity (contacts.jsx), источники данных
					    сознательно раздельные (§DISCOVERY часть C — компонент
					    не переиспользуется, чтобы не трогать profiles.value).
					    contact-info--decorated — на самой карточке (<article>),
					    не на текстовой подколонке: акцент — свойство всей
					    карточки целиком (с аватаром), не отдельного под-блока
					    (живой фидбек пользователя). */}
					<div class="contact-identity contact-identity--card row" style={{ "--gap": "var(--space-s)", "--align": "flex-start" }}>
						<figure class="contact-avatar-figure rigid">
							{previewAvatarUrl ? (
								<img src={previewAvatarUrl} alt="" width="40" height="40" class="contact-avatar contact-avatar--lg" />
							) : (
								<div aria-hidden="true" class="contact-avatar contact-avatar-fallback contact-avatar--lg row" style={{ "--align": "center", justifyContent: "center" }}>
									{(previewName || "?").trim().charAt(0).toUpperCase()}
								</div>
							)}
						</figure>
						<div class="contact-info stack grow box" style={{ "--gap": "var(--space-3xs)", "--pad": "var(--space-2xs)" }}>
							<span>{previewName}</span>
							{draft.showBio && previewBio && <small>{previewBio}</small>}
							{draftChannels.length > 0 ? (
								<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0, "--gap": "var(--space-2xs)" }} class="stack">
									{draftChannels.map((c) => (
										<li key={c.id}>
											<strong>{c.name}</strong>
											{c.description && <>: {c.description}</>}
											{draft.showRules && c.rules && <p class="panel__hint">{c.rules}</p>}
										</li>
									))}
								</ul>
							) : (
								<p class="panel__hint">{t("discovery.summaryNoChannelsPart")}</p>
							)}
						</div>
					</div>
				</article>
			</div>

			<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
				<input
					type="checkbox"
					class="set-row__switch"
					checked={draft.showBio}
					onChange={(e) => setDraft((prev) => ({ ...prev, showBio: e.currentTarget.checked }))}
					style={{ inlineSize: "1.7rem", blockSize: "1.7rem" }}
				/>
				<span class="set-row__text">{t("discovery.showBioToggle")}</span>
			</label>

			<div class="stack" style={{ "--gap": "var(--space-s)" }}>
				<span class="panel__hint">{t("discovery.channelsLegend")}</span>
				{ownedChannels.length === 0 ? (
					<p class="panel__hint">{t("discovery.noOwnChannels")}</p>
				) : (
					<div class="set-list stack" style={{ "--gap": "var(--space-s)" }}>
						{ownedChannels.map((c) => {
							const readers = readersByChannel[c.id] ?? 0;
							const checked = draft.channelIds.includes(c.id);
							return (
								<div key={c.id} class="stack" style={{ "--gap": "var(--space-2xs)" }}>
									<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
										<span class="set-row__text bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
											{c.name}
											{readers === 0 && <span class="badge badge--warn rigid">{t("discovery.soloChannelBadge")}</span>}
										</span>
										<span class="set-row__hint">{readers === 0 ? t("discovery.soloChannelHint") : t("discovery.readersCount", { count: readers })}</span>
										<input
											id={`${instanceId}-ch-${c.id}`}
											type="checkbox"
											class="set-row__switch"
											checked={checked}
											onChange={() => toggleDraftChannel(c.id)}
										/>
									</label>
									{checked && (
										<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
											<p class="panel__hint">{c.description}</p>
											{draft.showRules && c.rules && <p class="panel__hint">{c.rules}</p>}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
				<label class="set-row row" style={{ "--gap": "var(--space-2xs) var(--space-m)", "--align": "center" }}>
					<input
						type="checkbox"
						class="set-row__switch"
						checked={draft.showRules}
						onChange={(e) => setDraft((prev) => ({ ...prev, showRules: e.currentTarget.checked }))}
					/>
					<span class="set-row__text">{t("discovery.showRulesToggle")}</span>
				</label>
			</div>

			{soloSelected.length > 0 && (
				<p role="alert" class="callout callout--warn">
					{t("discovery.soloChannelWarning", { names: soloSelected.map((c) => c.name).join("», «") })}
				</p>
			)}

			{dirtyFields.length > 0 && (
				<p role="alert" class="callout callout--bad">
					{t("discovery.moderationWarning", { fields: dirtyFields.join(", ") })}
				</p>
			)}

			{error && (
				<p role="alert" class="callout callout--bad">
					{error}
				</p>
			)}

			<div class="bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<span class="panel__hint grow">{t("discovery.willSendSummary", { parts: summaryParts.join(", ") })}</span>
				<button type="button" class="rigid" onClick={closeCompose}>
					{t("common.cancel")}
				</button>
				<button type="button" class="rigid" onClick={handlePublish}>
					{t("discovery.publishButton", { duration: t(durationLabelKey) })}
				</button>
			</div>
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
	// CONTRACTS.md §DISCOVERY-REDESIGN, D8 — inline-форма причины жалобы
	// вместо window.prompt (в проекте нет ни одного модального <dialog>,
	// заводить первый прецедент ради формы из одного поля непропорционально).
	const [reportingPubkey, setReportingPubkey] = useState(null);
	const [reportReason, setReportReason] = useState("");

	useEffect(() => {
		ensureConnected(ownerPubkey, privKey, dbKey)
			.then(async () => {
				await fetchDiscoveryProfiles();
				await refreshDiscoveryProfiles(ownerPubkey);
				const discoveryPubkeys = discoveryProfiles.value.map((p) => p.pubkey);
				await ensureProfilesFresh(discoveryPubkeys, fetchProfiles, { force: true });
				// CONTRACTS.md §DISCOVERY — живая лента: снимок выше (одноразовый
				// REQ+EOSE) + постоянный хвост, чтобы новые трансляции появлялись без
				// ухода с экрана и возврата.
				await refreshLiveDiscoverySubscription(ownerPubkey);
			})
			.catch((e) => setConnectionError(errorMessage(e)));
	}, [ownerPubkey]);

	// CONTRACTS.md §DISCOVERY-REDESIGN, D3 — карточка с истёкшим visibleUntil
	// висела на экране до следующего REQ/живого события, пока экран открыт и
	// ничего не приходит. Тик раз в 30с — тот же интервал, что автоистечение
	// СВОЕЙ трансляции в VisibilitySection (независимый таймер: разные
	// компоненты, разная жизнь).
	useEffect(() => {
		const id = setInterval(() => refreshDiscoveryProfiles(ownerPubkey), 30000);
		return () => clearInterval(id);
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

	// CONTRACTS.md §DISCOVERY-REDESIGN, D7 — доступно ВСЕГДА (не только при
	// заданном BUILD_ADMIN_PUBKEY, как раньше была устроена жалоба).
	async function handleHideLocally(pubkey) {
		await hideDiscoveryProfileLocally(ownerPubkey, pubkey);
		discoveryProfiles.value = discoveryProfiles.value.filter((p) => p.pubkey !== pubkey);
	}

	function openReportForm(pubkey) {
		setReportingPubkey(pubkey);
		setReportReason("");
	}

	function closeReportForm() {
		setReportingPubkey(null);
		setReportReason("");
	}

	// CONTRACTS.md §DISCOVERY, T9 — 1-в-1 с ModerationActions.handleReport
	// (moderation-actions.jsx), отличия — адресат (admin, не владелец канала)
	// и локальное скрытие СРАЗУ, независимо от исхода publish (ТЗ: "немедленно
	// и навсегда, независимо от того, ушла ли жалоба в сеть"). Обрезка причины
	// до 200 — на стороне buildDiscoveryReportRumor (reports.js), симметрично
	// maxlength поля.
	async function submitReport(card) {
		await hideDiscoveryProfileLocally(ownerPubkey, card.pubkey);
		discoveryProfiles.value = discoveryProfiles.value.filter((p) => p.pubkey !== card.pubkey);
		const reason = reportReason;
		closeReportForm();
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
					// CONTRACTS.md §DISCOVERY-REDESIGN, Э7 — пустое состояние (самое частое
					// на старте) обязано быть спроектировано, не серый абзац. "Действие" —
					// не новая кнопка публикации (та уже есть в VisibilitySection), а
					// прокрутка к ней: два места управления одним и тем же действием —
					// лишняя сложность межкомпонентного состояния ради малой пользы.
					<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
						<h3 style={{ font: "inherit", fontWeight: "var(--weight-bold)" }}>{t("discovery.emptyTitle")}</h3>
						<p class="panel__hint">{t("discovery.emptyBody")}</p>
						<button
							type="button"
							class="rigid"
							onClick={() => document.getElementById("discovery-visibility")?.scrollIntoView({ behavior: "smooth", block: "start" })}
						>
							{t("discovery.showSelfButton")}
						</button>
					</div>
				) : (
					<ul role="list" class="contact-row-list">
						{discoveryProfiles.value.map((card) => {
							const sent = outgoingRequests.value.some((r) => r.peerPubkey === card.pubkey);
							const remainingSeconds = card.visibleUntil - nowSec();
							return (
								<li key={card.pubkey} class="contact-row stack" style={{ "--gap": "var(--space-s)" }}>
									<div class="contact-row-main row" style={{ "--gap": "var(--space-s)", "--align": "center", justifyContent: "space-between" }}>
										{/* decorated — тот же тёплый акцентный отсвет, что предпросмотр
										    "Как вас увидят другие" выше на экране, единая карточная
										    визуальная зона (CONTRACTS.md §DISCOVERY-REDESIGN, довесок). */}
										<ContactIdentity pubkey={card.pubkey} decorated />
										<div class="contact-row-actions row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
											<span class="panel__hint">{t("discovery.timeRemainingBadge", { time: formatCountdown(remainingSeconds) })}</span>
											<button type="button" disabled={busy} onClick={() => handleToggleDiscoveryCard(card.pubkey)} aria-pressed={sent}>
												{sent ? t("discovery.requestSentButton") : t("discovery.sendRequestButton")}
											</button>
											<ActionsMenu label={t("channel.comment.moreActionsAria", { name: profiles.value[card.pubkey]?.name || shortPubkey(card.pubkey) })}>
												<button type="button" onClick={() => handleHideLocally(card.pubkey)}>
													{t("discovery.hideLocallyAction")}
												</button>
												{BUILD_ADMIN_PUBKEY && (
													<button type="button" onClick={() => openReportForm(card.pubkey)}>
														{t("moderation.reportButton")}
													</button>
												)}
											</ActionsMenu>
										</div>
									</div>

									{card.channels.length > 0 && (
										<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
											{card.channels.map((c) => (
												<div key={c.id} class="ch-card box bar" style={{ "--gap": "var(--space-xs)", "--pad": "var(--space-2xs)", "--align": "center" }}>
													<div aria-hidden="true" class="contact-avatar contact-avatar-fallback row rigid" style={{ "--align": "center", justifyContent: "center" }}>
														{c.name.trim().charAt(0).toUpperCase()}
													</div>
													<div class="stack grow" style={{ "--gap": "var(--space-3xs)" }}>
														<strong>{c.name}</strong>
														{c.description && <p class="panel__hint">{c.description}</p>}
														{c.rules && (
															<details>
																<summary>{t("discovery.channelRulesSummary")}</summary>
																<p class="panel__hint">{c.rules}</p>
															</details>
														)}
													</div>
												</div>
											))}
										</div>
									)}

									{reportingPubkey === card.pubkey && (
										<div class="stack box" style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)", border: "var(--border-width) solid var(--border)", borderRadius: "var(--radius)" }}>
											<label class="stack" style={{ "--gap": "var(--space-3xs)" }}>
												<span class="panel__hint">{t("discovery.reportReasonLabel")}</span>
												<textarea maxLength={200} rows={2} value={reportReason} onInput={(e) => setReportReason(e.currentTarget.value)} />
											</label>
											<div class="bar" style={{ "--gap": "var(--space-s)" }}>
												<button type="button" class="rigid" onClick={closeReportForm}>
													{t("common.cancel")}
												</button>
												<button type="button" class="rigid" onClick={() => submitReport(card)}>
													{t("common.send")}
												</button>
											</div>
										</div>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</section>
		</Screen>
	);
}
