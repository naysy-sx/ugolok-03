// ТЗ-03, раздел 5 — экран хранилища (в «Настройках», не отдельным пунктом навигации:
// `storage` уже занят разделом «Файлы»).
//
// Числа — с сервера (GET /list/<pubkey>), имена — из журнала. Журнал подтягивается ПОСЛЕ
// того, как суммы показаны, и лишь подписывает строки; без него экран — нормальная работа
// на новом устройстве, а не ошибка.
import { useEffect, useRef, useState } from "preact/hooks";
import IconEmpty from "../icons/empty.jsx";
import { t, errorMessage, currentLocale } from "../signals/i18n.js";
import { fetchServerBlobs, totalBytes, reconcile, buildEntries, breakdownByPurpose, breakdownByKind } from "../../domain/uploads/storage.js";
import { listUploads, removeUploads, getJournalSync, getJournalStatus } from "../../domain/uploads/journal.js";
import { pullUploadJournal, refreshFreed } from "../signals/uploads.js";
import { formatBytes } from "../../domain/uploads/format.js";
import FreeSpaceDialog from "./free-space-dialog.jsx";
import QuotaBar from "./quota-bar.jsx";
import { quotaState, refreshQuota } from "../signals/quota.js";
import { goTo } from "../signals/place.js";
import { uploadTarget } from "../../domain/files/servers.js";

const PAGE = 20;
const PURPOSE_ORDER = ["dm", "group", "channel", "files", "share", "avatar", "unknown"];
const KIND_ORDER = ["image", "video", "audio", "document", "other", "unknown"];

function fmtDate(ms) {
	if (!ms) return "";
	try {
		return new Intl.DateTimeFormat(currentLocale.value, { dateStyle: "medium" }).format(new Date(ms));
	} catch {
		return new Date(ms).toLocaleDateString();
	}
}

function BreakdownList({ title, data, order, labelKey }) {
	const rows = order.filter((k) => data[k] > 0);
	if (rows.length === 0) return null;
	return (
		<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
			<h3 class="sect-title">{title}</h3>
			<ul class="stack" style={{ "--gap": "var(--space-3xs)", listStyle: "none", margin: 0, padding: 0 }}>
				{rows.map((k) => (
					<li key={k} class="bar" style={{ "--gap": "var(--space-s)", justifyContent: "space-between" }}>
						<span>{t(`${labelKey}.${k}`)}</span>
						<span style={{ color: "var(--muted)" }}>{formatBytes(data[k])}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export default function StoragePanel({ ownerPubkey, privKey }) {
	const [phase, setPhase] = useState("loading"); // loading | ready | error
	const [error, setError] = useState("");
	const [blobs, setBlobs] = useState([]);
	const [rows, setRows] = useState([]);
	const [journal, setJournal] = useState({ state: "idle", exhausted: false }); // idle | loading | done | failed
	const [visible, setVisible] = useState(PAGE);
	const [dialog, setDialog] = useState(null);
	const [pubStatus, setPubStatus] = useState({ dirty: 0, lastError: null }); // публикация журнала
	const [rec, setRec] = useState(null); // результат сверки
	const [recBusy, setRecBusy] = useState(false);
	const [recError, setRecError] = useState("");
	const alive = useRef(true);

	useEffect(() => {
		alive.current = true;
		load();
		return () => {
			alive.current = false;
		};
	}, [ownerPubkey]);

	async function loadJournal(maxPages) {
		setJournal((j) => ({ ...j, state: "loading" }));
		try {
			const res = await pullUploadJournal({ maxPages });
			const sync = await getJournalSync();
			if (!alive.current) return false;
			setRows(await listUploads());
			refreshFreed();
			setPubStatus(await getJournalStatus());
			const done = res.exhausted || !!sync?.exhausted;
			setJournal({ state: "done", exhausted: done });
			return done;
		} catch {
			if (!alive.current) return false;
			setRows(await listUploads());
			setJournal({ state: "failed", exhausted: false });
			return false;
		}
	}

	async function load() {
		setPhase("loading");
		setError("");
		try {
			// Сначала числа с сервера и то, что журнал уже знает локально — экран полезен сразу.
			const [serverBlobs, local] = await Promise.all([fetchServerBlobs(uploadTarget(), ownerPubkey, { privateKey: privKey }), listUploads()]);
			if (!alive.current) return;
			setBlobs(serverBlobs);
			setRows(local);
			setPubStatus(await getJournalStatus());
			setPhase("ready");
		} catch (err) {
			if (!alive.current) return;
			setError(errorMessage(err));
			setPhase("error");
			return;
		}
		// Остаток — заново (мог измениться на другом устройстве).
		refreshQuota();
		// Затем — по требованию, постранично — пачки журнала (только теперь, не при запуске).
		loadJournal(5);
	}

	const entries = buildEntries(blobs, rows);
	const shown = entries.slice(0, visible);

	async function refreshAfterChange() {
		setRec(null);
		refreshFreed();
		try {
			setBlobs(await fetchServerBlobs(uploadTarget(), ownerPubkey, { privateKey: privKey }));
			setRows(await listUploads());
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	async function runReconcile() {
		setRecBusy(true);
		setRecError("");
		setRec(null);
		try {
			// Сверка честна, только если журнал дочитан целиком: иначе настоящие файлы
			// выглядели бы «неопознанными», а кнопка «удалить все» их бы стёрла.
			const full = await loadJournal(1000);
			if (!full) {
				setRecError(t("storage.reconcile.needFull"));
				return;
			}
			const fresh = await fetchServerBlobs(uploadTarget(), ownerPubkey, { privateKey: privKey });
			const local = await listUploads();
			setBlobs(fresh);
			setRows(local);
			setRec(reconcile(fresh, local));
		} catch (err) {
			setRecError(errorMessage(err));
		} finally {
			setRecBusy(false);
		}
	}

	async function forgetMissing() {
		await removeUploads(rec.missing.map((r) => r.hash));
		setRows(await listUploads());
		setRec((r) => ({ ...r, missing: [] }));
	}

	function askFreeEntry(entry) {
		setDialog({
			hashes: entry.hashes,
			name: entry.known ? entry.name : t("storage.unknownEntry", { date: fmtDate(entry.at) }),
			size: entry.size,
			targets: entry.targets,
		});
	}

	function askDeleteUnknown() {
		setDialog({
			hashes: rec.unknown.map((b) => b.hash),
			size: rec.unknownBytes,
			targets: [],
			title: t("storage.reconcile.deleteUnknown"),
			body: t("storage.reconcile.confirmBody", { count: rec.unknown.length, size: formatBytes(rec.unknownBytes) }),
		});
	}

	const total = totalBytes(blobs);

	return (
		<div class="stack" style={{ "--gap": "var(--space-m)" }}>
			{phase === "loading" && (
				<p role="status" style={{ color: "var(--muted)" }}>
					{t("storage.loading")}
				</p>
			)}

			{phase === "error" && (
				<div class="stack" style={{ "--gap": "var(--space-xs)" }}>
					<p role="alert" class="callout callout--bad">
						{t("storage.serverFailed")} {error}
					</p>
					<div>
						<button type="button" class="btn--ghost" onClick={load}>
							{t("storage.retry")}
						</button>
					</div>
				</div>
			)}

			{phase === "ready" && (
				<>
					<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
						<h3 class="sect-title">{t("storage.usedTitle")}</h3>
						<p class="muted" style={{ margin: 0, fontSize: "var(--text-s, 0.85rem)" }}>{t("storage.serverLabel", { server: uploadTarget().replace(/^https?:\/\//, "") })}</p>
						{/* Полоса заполнения (ТЗ-04) сама показывает «занято X из Y» — второе число рядом было бы дублем */}
						{quotaState.value.status === "ok" && quotaState.value.quota?.enabled ? (
							<p class="muted" style={{ margin: 0, fontSize: "var(--text-s, 0.85rem)" }}>{t("storage.filesCount", { count: entries.length })}</p>
						) : (
							<p style={{ margin: 0, fontSize: "var(--text-l, 1.25rem)" }}>{t("storage.usedValue", { size: formatBytes(total), count: entries.length })}</p>
						)}
						{quotaState.value.status === "ok" && <QuotaBar quota={quotaState.value.quota} onGetMore={() => goTo({ kind: "plans" })} />}
						{quotaState.value.status === "ok" && quotaState.value.quota?.enabled && (
							<div>
								<button type="button" class="btn--ghost" onClick={() => goTo({ kind: "plans" })}>
									{t("storage.quota.plansLink")}
								</button>
							</div>
						)}
					</div>

					{blobs.length === 0 && <p style={{ color: "var(--muted)" }}>{t("storage.empty")}</p>}

					{pubStatus.dirty > 0 && pubStatus.lastError && (
						<p role="alert" class="callout callout--warn" style={{ margin: 0 }}>
							{t("storage.journalPublishFailed", { reason: pubStatus.lastError })}
						</p>
					)}

					{journal.state === "loading" && (
						<p role="status" style={{ color: "var(--muted)", margin: 0 }}>
							{t("storage.journalLoading")}
						</p>
					)}
					{journal.state === "failed" && (
						<div class="callout callout--warn stack" style={{ "--gap": "var(--space-2xs)" }}>
							<span>{t("storage.journalFailed")}</span>
							<div>
								<button type="button" class="btn--ghost" onClick={() => loadJournal(5)}>
									{t("storage.retry")}
								</button>
							</div>
						</div>
					)}
					{journal.state === "done" && !journal.exhausted && (
						<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
							<span style={{ color: "var(--muted)" }}>{t("storage.journalPartial")}</span>
							<div>
								<button type="button" class="btn--ghost" onClick={() => loadJournal(5)}>
									{t("storage.journalMore")}
								</button>
							</div>
						</div>
					)}

					{blobs.length > 0 && (
						<>
							<BreakdownList title={t("storage.byPurposeTitle")} data={breakdownByPurpose(entries)} order={PURPOSE_ORDER} labelKey="storage.purpose" />
							<BreakdownList title={t("storage.byKindTitle")} data={breakdownByKind(entries)} order={KIND_ORDER} labelKey="storage.kind" />

							<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
								<h3 class="sect-title">{t("storage.listTitle")}</h3>
								{/* Таблица, а не список: кнопки «Освободить место» стоят в одном столбце у правого
								    края и не «пляшут» от длины названий. Название обрезается многоточием (полное — в
								    подсказке), на телефоне у кнопки остаётся только иконка. */}
								<table class="storage-table">
									<caption class="visually-hidden">{t("storage.listTitle")}</caption>
									<tbody>
										{shown.map((e) => {
											const name = e.known ? e.name || t("storage.unnamed") : t("storage.unknownEntry", { date: fmtDate(e.at) });
											return (
												<tr key={e.key}>
													<td class="storage-table__file">
														<span class="storage-table__name" title={name}>
															{name}
														</span>
														<small class="storage-table__meta">
															{t("storage.entryMeta", { size: formatBytes(e.size), date: fmtDate(e.at) })}
															{e.sentTo > 0 ? ` · ${t("storage.sentTo", { count: e.sentTo })}` : ""}
														</small>
													</td>
													<td class="storage-table__action">
														<button type="button" class="btn--ghost" onClick={() => askFreeEntry(e)} aria-label={`${t("storage.free.button")}: ${name}`} title={t("storage.free.button")}>
															<IconEmpty /> <span class="btn-label">{t("storage.free.button")}</span>
														</button>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
								{entries.length > visible && (
									<div>
										<button type="button" class="btn--ghost" onClick={() => setVisible((v) => v + PAGE)}>
											{t("storage.showMore")}
										</button>
									</div>
								)}
							</div>
						</>
					)}

					<div class="stack" style={{ "--gap": "var(--space-xs)" }}>
						<div>
							<button type="button" class="btn--ghost" disabled={recBusy} onClick={runReconcile}>
								{recBusy ? t("storage.reconcile.running") : t("storage.reconcile.button")}
							</button>
						</div>
						{recError && (
							<p role="alert" class="callout callout--warn">
								{recError}
							</p>
						)}
						{rec && rec.unknown.length === 0 && rec.missing.length === 0 && (
							<p role="status" style={{ margin: 0 }}>
								{t("storage.reconcile.clean")}
							</p>
						)}
						{rec && rec.unknown.length > 0 && (
							<div class="callout callout--warn stack" style={{ "--gap": "var(--space-2xs)" }}>
								<strong>{t("storage.reconcile.unknownTitle", { count: rec.unknown.length, size: formatBytes(rec.unknownBytes) })}</strong>
								<span>{t("storage.reconcile.unknownRange", { from: fmtDate(Math.min(...rec.unknown.map((b) => b.uploaded)) * 1000), to: fmtDate(Math.max(...rec.unknown.map((b) => b.uploaded)) * 1000) })}</span>
								<span>{t("storage.reconcile.unknownHint")}</span>
								<div>
									<button type="button" class="btn--ghost btn--danger" onClick={askDeleteUnknown}>
										{t("storage.reconcile.deleteUnknown")}
									</button>
								</div>
							</div>
						)}
						{rec && rec.missing.length > 0 && (
							<div class="callout stack" style={{ "--gap": "var(--space-2xs)" }}>
								<strong>{t("storage.reconcile.missingTitle", { count: rec.missing.length })}</strong>
								<div>
									<button type="button" class="btn--ghost" onClick={forgetMissing}>
										{t("storage.reconcile.forgetMissing")}
									</button>
								</div>
							</div>
						)}
					</div>
				</>
			)}

			{dialog && <FreeSpaceDialog {...dialog} serverUrl={uploadTarget()} privKey={privKey} onClose={() => setDialog(null)} onDone={refreshAfterChange} />}
		</div>
	);
}
