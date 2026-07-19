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

const REASON_LABEL = { report: "Жалоба", ignore: "Игнор" };

// ТЗ: третья вкладка канала, только владелец. Список отчётов (жалобы+игноры), статистика,
// пометка просмотренных, бан прямо из строки репорта.
export default function ModerationPanel({ ownerPubkey, privKey, dbKey, channelId }) {
	const [reports, setReports] = useState([]);
	const [stats, setStats] = useState({ total: 0, unviewed: 0, topIgnored: [] });
	const [banned, setBanned] = useState([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	async function refresh() {
		setReports(await listReports(ownerPubkey, channelId));
		setStats(await getModerationStats(ownerPubkey, channelId));
		setBanned(await listBannedMembers(ownerPubkey, channelId));
	}

	useEffect(() => {
		refresh().catch((e) => setError(e?.message || String(e)));
	}, [ownerPubkey, channelId, messagingActivity.value]);

	async function handleBan(targetPubkey) {
		if (!window.confirm("Забанить этого участника? Он потеряет доступ к каналу, его контент будет скрыт у остальных. Действие необратимо (разбан не предусмотрен).")) return;
		setBusy(true);
		setError("");
		try {
			await banMember(ownerPubkey, privKey, dbKey, channelId, targetPubkey, publish);
			await refresh();
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div class="flow" style={{ "--flow-space": "var(--space-s)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<div class="cluster" style={{ alignItems: "center" }}>
				<p>
					Всего отчётов: <strong>{stats.total}</strong>, непросмотрено: <strong>{stats.unviewed}</strong>
				</p>
				{stats.unviewed > 0 && (
					<button type="button" onClick={() => markAllReportsViewed(ownerPubkey, channelId).then(refresh)}>
						Пометить всё просмотренным
					</button>
				)}
			</div>

			{stats.topIgnored.length > 0 && (
				<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
					<h3>Топ игнорируемых</h3>
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{stats.topIgnored.map((entry) => (
							<li key={entry.pubkey} class="cluster" style={{ alignItems: "center" }}>
								<ContactIdentity pubkey={entry.pubkey} />
								<small style={{ color: "var(--muted)" }}>проигнорирован {entry.count} участниками</small>
							</li>
						))}
					</ul>
				</div>
			)}

			{banned.length > 0 && (
				<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
					<h3>Забаненные ({banned.length})</h3>
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{banned.map((pubkey) => (
							<li key={pubkey}>
								<ContactIdentity pubkey={pubkey} />
							</li>
						))}
					</ul>
				</div>
			)}

			<div class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<h3>Отчёты</h3>
				{reports.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>Пока нет ни одной жалобы.</p>
				) : (
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }} class="flow">
						{reports.map((r) => (
							<li
								key={r.id}
								class="flow"
								style={{
									"--flow-space": "var(--space-3xs)",
									padding: "var(--space-s)",
									border: "var(--border-width) solid var(--border)",
									borderRadius: "var(--radius)",
									opacity: r.viewed ? 0.7 : 1,
								}}
							>
								<div class="cluster" style={{ alignItems: "center" }}>
									<strong>{REASON_LABEL[r.reason] || r.reason}</strong>
									{!r.viewed && <small style={{ color: "var(--accent)" }}>новое</small>}
								</div>
								<div class="cluster" style={{ alignItems: "center" }}>
									<span>От:</span>
									<ContactIdentity pubkey={r.reporterPubkey} />
								</div>
								<div class="cluster" style={{ alignItems: "center" }}>
									<span>На:</span>
									<ContactIdentity pubkey={r.targetPubkey} />
								</div>
								<p style={{ whiteSpace: "pre-wrap", color: "var(--muted)" }}>{r.contentText}</p>
								<div class="cluster">
									{!r.viewed && (
										<button type="button" onClick={() => markReportViewed(ownerPubkey, r.id).then(refresh)}>
											Пометить просмотренным
										</button>
									)}
									{!banned.includes(r.targetPubkey) && (
										<button type="button" disabled={busy} onClick={() => handleBan(r.targetPubkey)}>
											Забанить
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
