import { useState, useEffect } from "preact/hooks";
import { publish } from "../signals/transport.js";
import { messagingActivity } from "../signals/chats.js";
import {
	listReports,
	markReportViewed,
	markAllReportsViewed,
	getModerationStats,
	listBannedMembers,
	banMember,
} from "../../domain/content/moderation.js";
import { ContactIdentity } from "../screens/contacts.jsx";
import { t, errorMessage } from "../signals/i18n.js";

const REASON_LABEL_KEYS = { report: "moderation.reasonLabel.report", ignore: "moderation.reasonLabel.ignore" };

// ТЗ: третья вкладка канала, только владелец. Список отчётов (жалобы+игноры), статистика,
// пометка просмотренных, бан прямо из строки репорта.
export default function ModerationPanel({ ownerPubkey, privKey, dbKey, channelId }) {
	const [reports, setReports] = useState([]);
	const [stats, setStats] = useState({ total: 0, unviewed: 0, topIgnored: [] });
	const [banned, setBanned] = useState([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	async function refresh() {
		setReports(await listReports(ownerPubkey, dbKey, channelId));
		setStats(await getModerationStats(ownerPubkey, dbKey, channelId));
		setBanned(await listBannedMembers(ownerPubkey, channelId));
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

	return (
		<div class="stack" style={{ "--gap": "var(--space-s)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

			<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
				<p>
					{t("moderation.totalReports", { total: stats.total, unviewed: stats.unviewed })}
				</p>
				{stats.unviewed > 0 && (
					<button type="button" onClick={() => markAllReportsViewed(ownerPubkey, channelId).then(refresh)}>
						{t("moderation.markAllViewed")}
					</button>
				)}
			</div>

			{stats.topIgnored.length > 0 && (
				<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					<h3>{t("moderation.topIgnoredTitle")}</h3>
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{stats.topIgnored.map((entry) => (
							<li key={entry.pubkey} class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
								<ContactIdentity pubkey={entry.pubkey} />
								<small style={{ color: "var(--muted)" }}>{t("moderation.ignoredByCount", { count: entry.count })}</small>
							</li>
						))}
					</ul>
				</div>
			)}

			{banned.length > 0 && (
				<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					<h3>{t("moderation.bannedTitle", { count: banned.length })}</h3>
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{banned.map((pubkey) => (
							<li key={pubkey}>
								<ContactIdentity pubkey={pubkey} />
							</li>
						))}
					</ul>
				</div>
			)}

			<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
				<h3>{t("moderation.reportsTitle")}</h3>
				{reports.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>{t("moderation.noReports")}</p>
				) : (
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0, "--gap": "var(--space-m)" }} class="stack">
						{reports.map((r) => (
							<li
								key={r.id}
								class="stack box"
								style={{
									"--gap": "var(--space-3xs)",
									"--pad": "var(--space-s)",
									border: "var(--border-width) solid var(--border)",
									borderRadius: "var(--radius)",
									opacity: r.viewed ? 0.7 : 1,
								}}
							>
								<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
									<strong>{REASON_LABEL_KEYS[r.reason] ? t(REASON_LABEL_KEYS[r.reason]) : r.reason}</strong>
									{!r.viewed && <small style={{ color: "var(--accent)" }}>{t("moderation.newLabel")}</small>}
								</div>
								<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
									<span>{t("moderation.fromLabel")}</span>
									<ContactIdentity pubkey={r.reporterPubkey} />
								</div>
								<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
									<span>{t("moderation.toLabel")}</span>
									<ContactIdentity pubkey={r.targetPubkey} />
								</div>
								<p style={{ whiteSpace: "pre-wrap", color: "var(--muted)" }}>{r.contentText}</p>
								<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
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
			</div>
		</div>
	);
}
