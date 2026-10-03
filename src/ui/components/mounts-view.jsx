// Раздел «Полученные» экрана «Файлы»: список общих папок и содержимое одной доли.
// Доля — read-only: файлы можно смотреть (картинки/видео/аудио — в оверлее, документы — в карточке),
// фильтровать по типу и сохранять к себе. Ключ файла берётся из гранта (resolveMountFileKey),
// mime — из манифеста (в узле доли его нет), манифесты подтягиваются лениво и кэшируются.
import { useState, useEffect } from "preact/hooks";
import { activeMounts, mountProjections } from "../signals/mounts.js";
import { profiles } from "../signals/contacts.js";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { openMedia } from "../signals/media.js";
import { setMediaOrigin } from "../signals/media-origin.js";
import { getManifest } from "../../domain/files/content.js";
import { getCachedManifest, putCachedManifest } from "../../domain/files/store.js";
import { resolveMountFileKey } from "../../domain/files/mount.js";
import { ROOT_ID, TRASH_ID, LOST_FOUND_ID } from "../../domain/files/tree.js";
import { sortEntries } from "../../domain/files/sort.js";
import { filterByClass } from "../../domain/files/filter.js";
import { buildVisibleMediaPlaylist } from "../../domain/files/visible-media.js";
import { fileExtLabel, liveChildCount } from "../../domain/files/file-meta.js";
import { classOf } from "../../domain/media/media-ref.js";
import { uploadTarget } from "../../domain/files/servers.js";
import { formatFileSize } from "./attachment-view.jsx";
import FileThumbnail from "./file-thumbnail.jsx";
import FileTableHead from "./file-table-head.jsx";
import { useManifestInfo } from "../hooks/use-manifest-info.js";
import FileInfoDialog from "./file-info-dialog.jsx";
import TypeFilterBar from "./files-type-filter.jsx";
import IconGlobe from "../icons/globe.jsx";
import IconFolder from "../icons/folder.jsx";
import IconCopy from "../icons/copy.jsx";
import IconTrash from "../icons/trash.jsx";
import IconChevronRight from "../icons/chevron-right.jsx";
import { t, tPlural, errorMessage } from "../signals/i18n.js";


function MountsList({ openMountView, handleUnmountShare }) {
	const mounts = activeMounts.value;
	if (mounts.length === 0) return <p style={{ color: "var(--muted)" }}>{t("files.noSharedWithYou")}</p>;
	return (
		<table class="file-table">
			<thead>
				<tr>
					<th scope="col" class="file-table__icon">
						<span class="visually-hidden">{t("files.columnPreview")}</span>
					</th>
					<th scope="col">{t("files.columnName")}</th>
					<th scope="col" class="file-table__actions file-table__actions--wide">
						<span class="visually-hidden">{t("files.columnActions")}</span>
					</th>
				</tr>
			</thead>
			<tbody>
				{mounts.map((m) => {
					const name = profiles.value[m.ownerPubkey]?.name || `${m.ownerPubkey.slice(0, 16)}…`;
					return (
						<tr key={m.mountId} class="file-row">
							<td class="file-table__icon">
								<IconGlobe aria-hidden="true" class="icon file-row-icon" />
							</td>
							<td>
								<span class="file-row-name" title={name}>
									{name}
								</span>
							</td>
							<td class="file-table__actions file-table__actions--wide">
								<button type="button" class="btn--ghost" onClick={() => openMountView(m.mountId)} aria-label={t("files.openButton")} title={t("files.openButton")}>
									<IconChevronRight /> <span class="slice__label">{t("files.openButton")}</span>
								</button>
								<button type="button" class="btn--ghost btn--danger" onClick={() => handleUnmountShare(m.mountId)} aria-label={t("files.disconnectButton")} title={t("files.disconnectButton")}>
									<IconTrash /> <span class="slice__label">{t("files.disconnectButton")}</span>
								</button>
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

function MountFolder({ openMountId, mountFolderId, setMountFolderId, closeMountView, handleSaveToOwn, saveProgress }) {
	const ownerPubkey = currentUser.value.id;
	const [typeFilter, setTypeFilter] = useState("all");
	const [docInfo, setDocInfo] = useState(null);
	const [error, setError] = useState("");
	const [sortKey, setSortKey] = useState("name");
	const [sortDir, setSortDir] = useState("asc");
	const R = mountProjections.value.get(openMountId);

	// Mount.state — createInitialState() СОЗДАЁТ $trash/$lost+found: это технические узлы получателя,
	// владелец доли их не наполняет; показывать их бессмысленно.
	const rawEntries = R
		? (R.children.get(mountFolderId) ?? []).filter((id) => id !== TRASH_ID && id !== LOST_FOUND_ID).map((id) => ({ id, ...R.nodes.get(id) }))
		: [];
	// В долях (обычно небольших) манифесты всех файлов папки нужны сразу: и mime для фильтра, и размер для сортировки.
	const info = useManifestInfo(ownerPubkey, rawEntries.filter((e) => e.kind === "file"), uploadTarget());
	const entriesAll = rawEntries.map((e) => (e.kind === "file" ? { ...e, mime: e.mime ?? info[e.id]?.mime ?? null, size: info[e.id]?.size ?? 0 } : e));
	const entries = sortEntries(filterByClass(entriesAll, typeFilter), sortKey, sortDir);

	function changeSort(key) {
		if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		else {
			setSortKey(key);
			setSortDir("asc");
		}
	}

	useEffect(() => setTypeFilter("all"), [openMountId, mountFolderId]);

	if (!R) return null;

	const counts = { all: entriesAll.length, audio: 0, video: 0, image: 0, other: 0 };
	for (const e of entriesAll) {
		if (e.kind === "file" && e.mime) counts[classOf(e.mime)] += 1;
	}

	async function resolveRef(node) {
		const key = await resolveMountFileKey(ownerPubkey, dbKeySig.value, openMountId, node.id);
		if (!key) return null;
		let manifest = await getCachedManifest(ownerPubkey, node.blob);
		if (!manifest) {
			manifest = await getManifest(node.blob, { serverUrl: uploadTarget() });
			await putCachedManifest(ownerPubkey, node.blob, manifest);
		}
		return { digest: node.blob, key, mime: manifest.mime, name: manifest.name || node.displayName, size: manifest.size, sourceKind: "node", sourceMeta: { nodeId: node.id, mountId: openMountId } };
	}

	async function openEntry(entry, event) {
		setError("");
		if (entry.kind === "dir") {
			setMountFolderId(entry.id);
			return;
		}
		try {
			const cls = entry.mime ? classOf(entry.mime) : "other";
			if (cls === "audio" || cls === "video" || cls === "image") {
				const { items, position } = buildVisibleMediaPlaylist(entries, entry.id);
				const refs = [];
				for (const node of items) {
					const ref = await resolveRef(node);
					if (!ref) {
						setError(t("chat.window.fileKeyNotFoundError"));
						return;
					}
					refs.push(ref);
				}
				if (event?.currentTarget) setMediaOrigin(event.currentTarget.getBoundingClientRect());
				openMedia({ refs, position });
				return;
			}
			const mediaRef = await resolveRef(entry);
			if (!mediaRef) {
				setError(t("chat.window.fileKeyNotFoundError"));
				return;
			}
			setDocInfo({ entry, mediaRef });
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	return (
		<div class="stack">
			<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				{mountFolderId !== ROOT_ID && (
					<button type="button" class="btn--ghost" onClick={() => setMountFolderId(ROOT_ID)}>
						{t("files.mountRootButton")}
					</button>
				)}
			</div>
			<TypeFilterBar counts={counts} active={typeFilter} onSelect={setTypeFilter} />
			{saveProgress && <p role="status">{t("files.savingProgress", { done: saveProgress.filesDone, total: saveProgress.filesTotal })}</p>}
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			{entries.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>{typeFilter !== "all" ? t("files.typeEmpty") : t("files.folderEmpty")}</p>
			) : (
				<table class="file-table">
					<FileTableHead sortKey={sortKey} sortDir={sortDir} onSort={changeSort} showAccess={false} />
					<tbody>
						{entries.map((entry) => (
							<tr key={entry.id} class="file-row">
								<td class="file-table__icon">
									{entry.kind === "dir" ? (
										<IconFolder aria-hidden="true" class="icon file-row-icon" />
									) : (
										<FileThumbnail
											entry={entry}
											ownerPubkey={ownerPubkey}
											resolveKey={() => resolveMountFileKey(ownerPubkey, dbKeySig.value, openMountId, entry.id)}
											onManifest={() => {}}
										/>
									)}
								</td>
								<td>
									<button type="button" class="file-row-name" title={entry.displayName} onClick={(e) => openEntry(entry, e)}>
										{entry.displayName}
									</button>
								</td>
								<td class="file-table__type">
									<small class="file-row-status">{entry.kind === "dir" ? t("files.kindFolder") : fileExtLabel(entry.displayName)}</small>
								</td>
								<td class="file-table__size">
									<small class="file-row-status">
										{entry.kind === "dir" ? tPlural("files.objectCount", liveChildCount(R.children, entry.id)) : info[entry.id]?.size != null ? formatFileSize(info[entry.id].size) : ""}
									</small>
								</td>
								<td class="file-table__actions">
									<button
										type="button"
										class="btn--ghost"
										onClick={() => handleSaveToOwn(openMountId, entry.id)}
										disabled={!!saveProgress}
										aria-label={t("files.saveToOwnButton")}
										title={t("files.saveToOwnButton")}
									>
										<IconCopy /> <span class="slice__label">{t("files.saveToOwnButton")}</span>
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{docInfo && <FileInfoDialog entry={docInfo.entry} mediaRef={docInfo.mediaRef} onClose={() => setDocInfo(null)} />}
		</div>
	);
}

export default function MountsView(props) {
	if (props.openMountId === null) return <MountsList openMountView={props.openMountView} handleUnmountShare={props.handleUnmountShare} />;
	return <MountFolder {...props} />;
}
