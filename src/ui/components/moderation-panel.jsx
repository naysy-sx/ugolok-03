import { useState, useEffect } from "preact/hooks";
import { publish, fetchProfiles, refreshLiveProfileSubscription } from "../signals/transport.js";
import { messagingActivity } from "../signals/chats.js";
import { ensureProfilesFresh, watchProfiles } from "../signals/contacts.js";
import { commentAuthorInfo } from "./channel-shared.jsx";
import { formatDateTime } from "./post-card.jsx";
import {
	listReports,
	markReportViewed,
	markAllReportsViewed,
	getModerationStats,
	listBannedMembers,
	banMember,
} from "../../domain/content/moderation.js";
import IconArrowRight from "../icons/arrow-right.jsx";
import { t, errorMessage } from "../signals/i18n.js";

const REASON_LABEL_KEYS = { report: "moderation.reasonLabel.report", ignore: "moderation.reasonLabel.ignore" };

// CHANNEL-V2 часть F4 — компактная строка личности. ContactIdentity (2.5rem
// аватар + имя + био блоком) в списке жалоб неуместен: в строке «от X к Y»
// это два блока по 40 px и два био.
export function IdentityInline({ pubkey }) {
	const author = commentAuthorInfo(pubkey);
	return (
		<span class="identity-inline bar" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
			{author.avatar ? (
				<img src={author.avatar} alt="" class="identity-inline__ava" />
			) : (
				<span aria-hidden="true" class="identity-inline__ava identity-inline__ava-fallback">
					{(author.name || "?").trim().charAt(0).toUpperCase()}
				</span>
			)}
			<span class={author.isNpub ? "identity-inline__name identity-inline__name--npub truncate" : "identity-inline__name truncate"} style={{ "--lines": "1" }}>
				{author.name}
			</span>
		</span>
	);
}

// ТЗ: третья вкладка канала, только владелец. Список отчётов (жалобы+игноры), статистика,
// пометка просмотренных, бан прямо из строки репорта.
// CHANNEL-V2 часть F1-F5 — было три несвязанных .stack подряд (статистика,
// «топ игнорируемых», заблокированные, отчёты), ContactIdentity на 2.5rem
// внутри строки «От: …», просмотренная жалоба гасилась opacity:0.7 — вместе
// с текстом самой жалобы, то есть падал контраст ровно того, что модератор
// читает. Теперь один список с фильтром-чипами; «топ игнорируемых» —
// значение фильтра (entries с reason:"ignore" в том же списке), не
// отдельная агрегированная секция.
export default function ModerationPanel({ ownerPubkey, privKey, dbKey, channelId }) {
	const [reports, setReports] = useState([]);
	const [stats, setStats] = useState({ total: 0, unviewed: 0, topIgnored: [] });
	const [banned, setBanned] = useState([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [filter, setFilter] = useState("unviewed");

	async function refresh() {
		const freshReports = await listReports(ownerPubkey, dbKey, channelId);
		const freshBanned = await listBannedMembers(ownerPubkey, channelId);
		setReports(freshReports);
		setStats(await getModerationStats(ownerPubkey, dbKey, channelId));
		setBanned(freshBanned);
		// CHANNEL-V2 часть A2/A3 — до этой правки модерация вообще не запрашивала
		// профили: в списке жалоб npub стоял всегда, даже когда профиль был
		// доступен (отдельный симптом той же болезни, что и лента канала).
		const pubkeys = [...new Set([...freshReports.flatMap((r) => [r.reporterPubkey, r.targetPubkey]), ...freshBanned])];
		if (watchProfiles(pubkeys)) refreshLiveProfileSubscription(ownerPubkey);
		ensureProfilesFresh(pubkeys, fetchProfiles, { force: true }).catch(() => {});
	}

	useEffect(() => {
		refresh().catch((e) => setError(errorMessage(e)));
	}, [ownerPubkey, channelId, messagingActivity.value]);

	async function handleBan(targetPubkey) {
		if (!window.confirm(t("moderation.banConfirm"))) return;
		setBusy(true);
		setError("");
		try {
			await banMember(ownerPubkey, privKey, dbKey, channelId, targetPubkey, publish);
			await refresh();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	// F2 — фильтр переключает список из уже загруженного reports, без
	// повторного запроса из базы на каждый клик (приёмка п.22).
	const filteredReports = reports.filter((r) => {
		if (filter === "unviewed") return !r.viewed;
		if (filter === "report") return r.reason === "report";
		if (filter === "ignore") return r.reason === "ignore";
		return true; // "all"
	});

	return (
		<div class="stack" style={{ "--gap": "var(--space-s)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

			<div class="mod-stats row" style={{ "--gap": "var(--space-2xs)" }}>
				<div class={`mod-stat box grow${stats.unviewed > 0 ? " mod-stat--alert" : ""}`} style={{ "--pad": "var(--space-s)" }}>
					<span class="mod-stat__n">{stats.unviewed}</span>
					<span class="mod-stat__l">{t("moderation.statUnviewed")}</span>
				</div>
				<div class="mod-stat box grow" style={{ "--pad": "var(--space-s)" }}>
					<span class="mod-stat__n">{stats.total}</span>
					<span class="mod-stat__l">{t("moderation.statTotal")}</span>
				</div>
				<div class="mod-stat box grow" style={{ "--pad": "var(--space-s)" }}>
					<span class="mod-stat__n">{banned.length}</span>
					<span class="mod-stat__l">{t("moderation.statBanned")}</span>
				</div>
			</div>

			<div class="mod-filters reel" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
				<button type="button" class="mod-filter" aria-pressed={filter === "unviewed"} onClick={() => setFilter("unviewed")}>
					{t("moderation.filterUnviewed", { count: stats.unviewed })}
				</button>
				<button type="button" class="mod-filter" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
					{t("moderation.filterAll", { count: stats.total })}
				</button>
				<button type="button" class="mod-filter" aria-pressed={filter === "report"} onClick={() => setFilter("report")}>
					{t("moderation.filterReports")}
				</button>
				<button type="button" class="mod-filter" aria-pressed={filter === "ignore"} onClick={() => setFilter("ignore")}>
					{t("moderation.filterIgnores")}
				</button>
				{/* НЕ из ТЗ (F2 снимка не содержал) — сохраняю рабочую функцию
				    "пометить всё просмотренным": ТЗ переписывает разметку панели
				    целиком и просто не упомянул её, но домен-функция осталась и
				    молчаливая потеря рабочей возможности — не то же самое, что
				    "не рефакторить попутно". */}
				{filter === "unviewed" && stats.unviewed > 0 && (
					<button type="button" class="btn--ghost" onClick={() => markAllReportsViewed(ownerPubkey, channelId).then(refresh)}>
						{t("moderation.markAllViewed")}
					</button>
				)}
			</div>

			{filteredReports.length === 0 ? (
				<div class="empty stack" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					<h2>{t("moderation.emptyTitle")}</h2>
					<p>{t("moderation.emptyHint")}</p>
				</div>
			) : (
				<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }} class="stack">
					{filteredReports.map((r) => (
						<li key={r.id} class={`mod-report box stack${r.viewed ? " mod-report--viewed" : ""}`} style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)" }}>
							<div class="mod-report__top row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
								<span class="mod-report__reason">{t(REASON_LABEL_KEYS[r.reason] ?? r.reason)}</span>
								{!r.viewed && <span class="mod-report__new">{t("moderation.newLabel")}</span>}
								<time class="chat-msg__time grow" style={{ textAlign: "end" }}>
									{formatDateTime(r.createdAt)}
								</time>
							</div>

							<div class="mod-report__flow row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
								<span>{t("moderation.fromLabel")}</span>
								<IdentityInline pubkey={r.reporterPubkey} />
								<IconArrowRight aria-hidden="true" />
								<IdentityInline pubkey={r.targetPubkey} />
							</div>

							{/* Markdown-этап E — намеренно RAW, не MarkdownView: модератор
							    должен видеть исходник жалобы буквально, рендер разметки
							    позволил бы спрятать содержимое (пустая ссылка, схлопнутая
							    структура). */}
							<blockquote class="mod-report__quote">{r.contentText}</blockquote>

							<div class="mod-report__acts row" style={{ "--gap": "var(--space-2xs)" }}>
								{!r.viewed && (
									<button type="button" onClick={() => markReportViewed(ownerPubkey, r.id).then(refresh)}>
										{t("moderation.markViewedButton")}
									</button>
								)}
								{!banned.includes(r.targetPubkey) && (
									<button type="button" class="btn--ghost btn--danger" disabled={busy} onClick={() => handleBan(r.targetPubkey)}>
										{t("moderation.banButton")}
									</button>
								)}
							</div>
						</li>
					))}
				</ul>
			)}

			{/* F5 — снятие бана в домене не реализовано (нет unbanMember в
			    domain/content/moderation.js) — по ТЗ в этом случае кнопку не
			    рисуем и не выдумываем функцию, оставляем список как есть. */}
			{banned.length > 0 && (
				<ul class="mod-banned row" style={{ "--gap": "var(--space-2xs)" }}>
					{banned.map((pubkey) => (
						<li key={pubkey}>
							<IdentityInline pubkey={pubkey} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
