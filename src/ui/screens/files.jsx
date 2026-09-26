import { useState, useEffect, useRef } from "preact/hooks";
import Screen from "../components/screen.jsx";
import ActionsMenu from "../components/actions-menu.jsx";
import IconFolder from "../icons/folder.jsx";
import IconFolderPlus from "../icons/folder-plus.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconTrash from "../icons/trash.jsx";
import IconCopy from "../icons/copy.jsx";
import IconChevronRight from "../icons/chevron-right.jsx";
import IconCheck from "../icons/check.jsx";
import IconCross from "../icons/cross.jsx";
import IconUpload from "../icons/upload.jsx";
import IconViewList from "../icons/view-list.jsx";
import IconSquaresFour from "../icons/squares-four.jsx";
import IconMusicNote from "../icons/music-note.jsx";
import IconVideoCamera from "../icons/video-camera.jsx";
import IconImage from "../icons/image-icon.jsx";
import IconFileText from "../icons/file-text.jsx";
import IconPlayerPlay from "../icons/player-play.jsx";
import { currentUser, privKeySig } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import {
	initFiles,
	currentFolderId,
	currentEntries,
	breadcrumbPath,
	clipboard,
	clipboardHasContent,
	canUndo,
	createFolder,
	createFileEntry,
	backfillMime,
	renameNode,
	removeNode,
	purgeNode,
	moveNode,
	copySelection,
	cutSelection,
	pasteHere,
	cancelSelection,
	undo,
	openFolder,
	getFileKeyFor,
	treeState,
	projected,
} from "../signals/files.js";
import { sharedNodeIds, initShares, shareFolder, revokeAccess, listGrantees } from "../signals/shares.js";
import { activeMounts, mountProjections, ensureMountProjection, saveMountedItemToOwn, unmountShare } from "../signals/mounts.js";
import { contacts, profiles } from "../signals/contacts.js";
import { dbKeySig } from "../signals/auth.js";
import { ROOT_ID, TRASH_ID, LOST_FOUND_ID } from "../../domain/files/tree.js";
import { sortEntries } from "../../domain/files/sort.js";
import { filterEntries, filterByClass } from "../../domain/files/filter.js";
import { layoutFor } from "../../domain/files/view-layout.js";
import { buildVisibleMediaPlaylist } from "../../domain/files/visible-media.js";
import { classOf } from "../../domain/media/media-ref.js";
import { PreconditionError, targetInsideSubtree } from "../../domain/files/ops.js";
import { getManifest, getRange } from "../../domain/files/content.js";
import { putFilesStreaming } from "../../domain/files/stream-upload.js";
import { recordBlobs, getGroupOfHash } from "../../domain/uploads/journal.js";
import { freedDigests, refreshFreed } from "../signals/uploads.js";
import FreeSpaceDialog from "../components/free-space-dialog.jsx";
import TypeFilterBar from "../components/files-type-filter.jsx";
import FileInfoDialog from "../components/file-info-dialog.jsx";
import FileThumbnail from "../components/file-thumbnail.jsx";
import FileTableHead from "../components/file-table-head.jsx";
import { useManifestInfo } from "../hooks/use-manifest-info.js";
import MountsView from "../components/mounts-view.jsx";
import { formatFileSize } from "../components/attachment-view.jsx";
import { fileExtLabel, joinMeta, liveChildCount } from "../../domain/files/file-meta.js";
import IconRestore from "../icons/restore.jsx";
import IconScissors from "../icons/scissors.jsx";
import IconEmpty from "../icons/empty.jsx";
import { getCachedManifest, putCachedManifest } from "../../domain/files/store.js";
import IconMagnifyingGlass from "../icons/magnifying-glass.jsx";
import IconGlobe from "../icons/globe.jsx";
import IconPeople from "../icons/people.jsx";
import { useVirtualWindow } from "../hooks/use-virtual-window.js";
import { openMedia } from "../signals/media.js";
import { setMediaOrigin } from "../signals/media-origin.js";
import { t, tPlural, errorMessage as translateErrorMessage } from "../signals/i18n.js";
import { uploadTarget } from "../../domain/files/servers.js";

const FILTER_DEBOUNCE_MS = 150; // ALGO.MD §13 — "дебаунс в 100-150 мс"
const ROW_HEIGHT_PX = 72; // = --file-row-height в custom.css, держать в синхроне

const TYPE_MODE = {
	image: { labelKey: "files.typeImages", Icon: IconImage, playKey: "files.watch" },
	video: { labelKey: "files.typeVideo", Icon: IconVideoCamera, playKey: "files.watchSequential" },
	audio: { labelKey: "files.typeAudio", Icon: IconMusicNote, playKey: "files.playSequential" },
	other: { labelKey: "files.typeDocs", Icon: IconFileText, playKey: null },
};

// Ячейка «Размер» таблицы: для папки — число элементов, для файла — размер из манифеста; статус
// «ремонта» и пометка «удалён с сервера» (ТЗ-03) показываются вместо размера, как и в плитках.
function FileSizeCell({ entry, size }) {
	if (entry.kind === "file" && entry.blob && freedDigests.value.has(entry.blob)) {
		return (
			<small class="file-row-status" title={t("files.freedFromServer")} style={{ color: "var(--warn, var(--muted))" }}>
				{t("files.freedFromServer")}
			</small>
		);
	}
	if (STATUS_LABEL_KEYS[entry.status]) {
		return (
			<small class="file-row-status" title={t(STATUS_LABEL_KEYS[entry.status])}>
				{t(STATUS_LABEL_KEYS[entry.status])}
			</small>
		);
	}
	if (entry.kind === "dir") return <small class="file-row-status">{tPlural("files.objectCount", liveChildCount(projected.value.children, entry.id))}</small>;
	return <small class="file-row-status">{size != null ? formatFileSize(size) : ""}</small>;
}

function FileMetaLabel({ entry, ownerPubkey, class: cls }) {
	const [size, setSize] = useState(null);
	useEffect(() => {
		if (entry.kind !== "file" || !entry.blob) return;
		let cancelled = false;
		(async () => {
			let m = await getCachedManifest(ownerPubkey, entry.blob);
			if (!m) {
				try {
					m = await getManifest(entry.blob, { serverUrl: uploadTarget() });
					if (m) await putCachedManifest(ownerPubkey, entry.blob, m);
				} catch {
					return;
				}
			}
			if (!cancelled && m?.size != null) setSize(m.size);
		})();
		return () => {
			cancelled = true;
		};
	}, [entry.blob, entry.kind, ownerPubkey]);

	// ТЗ-03: байты стёрты с сервера («освободить место») — узел остался, но не откроется.
	if (entry.kind === "file" && entry.blob && freedDigests.value.has(entry.blob)) {
		return (
			<small class={cls} style={{ color: "var(--warn, var(--muted))" }}>
				{t("files.freedFromServer")}
			</small>
		);
	}
	if (STATUS_LABEL_KEYS[entry.status]) {
		return <small class={cls}>{t(STATUS_LABEL_KEYS[entry.status])}</small>;
	}
	if (entry.kind === "dir") {
		const n = liveChildCount(projected.value.children, entry.id);
		return <small class={cls}>{tPlural("files.objectCount", n)}</small>;
	}
	const text = joinMeta([fileExtLabel(entry.displayName), size != null ? formatFileSize(size) : ""]);
	if (!text) return null;
	return <small class={cls}>{text}</small>;
}

// "Ремонт" (project(), tree.js) сделал что-то за пользователя молча —
// показываем факт, не только результат (MATH.md §12.3: решение принято —
// показывать, данные для этого уже есть в поле status бесплатно).
const STATUS_LABEL_KEYS = {
	repaired: "files.status.repaired",
	orphaned: "files.status.orphaned",
	renamed: "files.status.renamed",
};

function errorMessage(result) {
	return result instanceof PreconditionError ? translateErrorMessage(result) : null;
}

// FILES-FIX-SPEC.md §5.1.2, TZ-FIX-FILES-MEDIA-STATIC.md решение №2 — прогресс
// обязан отражать СЕТЬ, не только шифрование (аудит: "100% за секунды, потом
// минуты тишины на единственном PUT" читалось пользователем как зависание).
// index — порядковый номер ТЕКУЩЕГО в работе файла (concurrency=2 — несколько
// job'ов идут одновременно, index=filesDone+1 — тот же смысл, что раньше
// имел однопоточный for, "который по счёту").
function uploadProgressText(state) {
	const index = state.filesDone + 1;
	const total = state.filesTotal;
	const name = state.fileName ?? "";
	if (state.phase === "upload") {
		return t("files.uploadingProgressUpload", {
			name,
			index,
			total,
			sent: formatFileSize(state.bytesSent ?? 0),
			size: formatFileSize(state.bytesTotal ?? 0),
		});
	}
	if (state.phase === "manifest") {
		return t("files.uploadingProgressManifest", { name, index, total });
	}
	const percent = state.chunksTotal ? Math.round((state.chunksDone / state.chunksTotal) * 100) : 0;
	return t("files.uploadingProgress", { name, index, total, percent });
}

// Пока БЕЗ виртуализации (задача 3.2) и миниатюр (3.8) — вторая волна
// добавила фильтр (3.7). Файлы (в отличие от папок) показывают общую
// иконку — размер/mime живут в манифесте (content.js), не в самом узле
// дерева; подгрузка манифеста по каждой строке — из той же серии, что
// миниатюры, следующим шагом (3.8), не задача этого прохода.
// Плитки «Файлов» крупнее строк списка: миниатюра 200px на плитке в ~180 CSS-px при
// плотности экрана 2 выглядела зернистой — для плитки строим кадр покрупнее.
const TILE_THUMBNAIL_SIZE = 520;

export default function Files() {
	const ownerPubkey = currentUser.value.id;
	const [ready, setReady] = useState(false);
	const [selected, setSelected] = useState(() => new Set());
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const [renamingId, setRenamingId] = useState(null);
	const [renameValue, setRenameValue] = useState("");
	const [error, setError] = useState("");
	const [searchInput, setSearchInput] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const containerRef = useRef(null);

	// 6.7 (сужение MVP, CONTRACTS.md) — "Полученные доли" ОТДЕЛЬНЫЙ раздел,
	// своя локальная навигация (mountFolderId), не смешивается с основным
	// деревом/буфером обмена/undo (read-only с точки зрения UI — share() в
	// v0.1 производит только read-гранты).
	const [view, setView] = useState("own"); // "own" | "mounts"
	const [shareDialogTarget, setShareDialogTarget] = useState(null); // nodeId папки
	const [freeDialog, setFreeDialog] = useState(null); // ТЗ-03: диалог «освободить место»
	const [shareSelectedPubkeys, setShareSelectedPubkeys] = useState(() => new Set());
	const [shareBusy, setShareBusy] = useState(false);
	const [shareProgress, setShareProgress] = useState(null); // {done, total, name, fraction} — копирование файлов для читателей
	const [shareError, setShareError] = useState("");
	const [accessPanelTarget, setAccessPanelTarget] = useState(null); // nodeId папки
	const [grantees, setGrantees] = useState([]);
	const [openMountId, setOpenMountId] = useState(null);
	const [mountFolderId, setMountFolderId] = useState(ROOT_ID);
	const [saveProgress, setSaveProgress] = useState(null); // {filesDone, filesTotal} | null

	// Загрузка с диска (§7 TASK.md: "прогресс и отмена для загрузки —
	// хеширование нескольких гигабайт — десятки секунд; без индикатора это
	// выглядит как зависание"). Несколько файлов — ОЧЕРЕДЬ, последовательно
	// (не параллельно — не перегружать шифрование/сеть, прогресс остаётся
	// понятным как "файл N из M"). uploadAbortRef — ОДИН AbortController на
	// ТЕКУЩИЙ файл; отмена останавливает и его, и всю оставшуюся очередь
	// (не переходит к следующему файлу молча).
	const [uploadState, setUploadState] = useState(null); // {fileName, fileIndex, filesTotal, phase, chunksDone, chunksTotal, bytesSent, bytesTotal} | null
	const [uploadError, setUploadError] = useState("");
	const [mediaButtonsBusy, setMediaButtonsBusy] = useState(false);
	const [typeFilter, setTypeFilter] = useState("all");
	const [sortKey, setSortKey] = useState("name"); // name | type | size
	const [sortDir, setSortDir] = useState("asc");
	const [viewOverride, setViewOverride] = useState({});
	const [docInfo, setDocInfo] = useState(null); // {entry, mediaRef} | null
	const fileInputRef = useRef(null);
	const uploadAbortRef = useRef(null);

	// Drag-and-drop (§7 TASK.md, честно отложено в И3 — PLAN.md "перетаскивание
	// мышью... drag — нет"). draggedIds — что тащим (весь selected, если тащим
	// элемент ИЗ выделения размером >1, иначе только сам элемент); dragOverId —
	// папка-цель под курсором, для подсветки. Валидность цели (d∉subtree(n))
	// проверяется НА КАЖДЫЙ кадр наведения (§7 TASK.md п.211: восхождением, не
	// спуском) — targetInsideSubtree (ops.js) переиспользован напрямую из
	// предусловия move(), не переизобретён здесь.
	const [draggedIds, setDraggedIds] = useState(null);
	const [dragOverId, setDragOverId] = useState(null);

	useEffect(() => {
		Promise.all([initFiles(ownerPubkey, privKeySig.value, publish), initShares(ownerPubkey)]).then(() => setReady(true));
	}, [ownerPubkey]);

	function triggerFileUpload() {
		fileInputRef.current?.click();
	}

	// Очередь БЕЗ break (FILES-FIX-SPEC.md §7.3, TZ-FIX-FILES-MEDIA-STATIC.md
	// решение №4) — ошибка/отмена ОДНОГО файла раньше обрывала весь список
	// (`break` останавливал for). Теперь putFilesStreaming(concurrency:2) сам
	// шифрует+грузит несколько файлов параллельно (стадия шифрования job(i+1)
	// перекрывается с сетью job(i)); putFilesStreaming НЕ переписан (его
	// Promise.all по-прежнему падает на первой ошибке — см. комментарий в
	// stream-upload.js), поэтому успех/неуспех КАЖДОГО файла собирается через
	// onJobDone/onJobError, а не через резолв целиком (outer try/catch —
	// только чтобы не уронить остаток функции, реальная сводка ниже).
	async function handleFilesSelected(e) {
		const files = [...e.target.files];
		e.target.value = ""; // тот же файл повторно — иначе повторный выбор того же файла не даст onChange
		if (files.length === 0) return;
		setUploadError("");
		const controller = new AbortController();
		uploadAbortRef.current = controller;

		const succeeded = []; // {i, result}
		const failed = []; // {i, err}
		setUploadState({ filesTotal: files.length, filesDone: 0 });

		const jobs = files.map((file) => ({
			file,
			options: {
				name: file.name,
				mime: file.type || "application/octet-stream",
				serverUrl: uploadTarget(),
				privateKey: privKeySig.value,
				onProgress: (p) => setUploadState((prev) => (prev ? { ...prev, fileName: file.name, ...p } : prev)),
			},
		}));

		// Promise.all внутри putFilesStreaming отклоняется на ПЕРВОЙ ошибке,
		// не дожидаясь остальных job'ов (стандартная семантика Promise.all) —
		// поэтому дожидаемся здесь не его, а собственного счётчика "все job'ы
		// СОБСТВЕННО отчитались" через onJobDone/onJobError. Иначе job B мог бы
		// всё ещё грузиться в фоне в момент, когда job A уже провалился и код
		// ниже начал бы обрабатывать succeeded/failed преждевременно — файл B
		// либо потерял бы свою запись в дереве, либо его ошибка осталась бы
		// незамеченной.
		let settledCount = 0;
		const allSettled = new Promise((resolve) => {
			function noteSettled() {
				settledCount += 1;
				if (settledCount === jobs.length) resolve();
			}
			putFilesStreaming(jobs, {
				concurrency: 2,
				signal: controller.signal,
				onJobDone: (i, result) => {
					// ТЗ-03: журнал загрузок (purpose files, цель — папка, куда грузим).
					recordBlobs(result.blobs, { purpose: "files", target: currentFolderId.value, name: files[i].name, server: uploadTarget() }).catch(() => {});
					succeeded.push({ i, result });
					noteSettled();
					setUploadState((prev) => (prev ? { ...prev, filesDone: prev.filesDone + 1 } : prev));
				},
				onJobError: (i, err) => {
					failed.push({ i, err });
					noteSettled();
					setUploadState((prev) => (prev ? { ...prev, filesDone: prev.filesDone + 1 } : prev));
				},
			}).catch(() => {}); // ошибки уже собраны per-job через onJobError выше
		});
		await allSettled;

		succeeded.sort((a, b) => a.i - b.i);
		const entryErrors = []; // {i, message} — createFileEntry отклонил уже загруженный файл
		for (const { i, result } of succeeded) {
			const { manifest, manifestDigest, fileKey } = result;
			if (manifest) await putCachedManifest(ownerPubkey, manifestDigest, manifest);
			const entryResult = await createFileEntry(files[i].name, manifestDigest, fileKey, null, files[i].type || "application/octet-stream");
			const message = errorMessage(entryResult);
			if (message) entryErrors.push({ i, message });
		}

		const uploadFailures = failed.filter(({ err }) => err.name !== "AbortError");
		if (uploadFailures.length > 0 || entryErrors.length > 0) {
			uploadFailures.sort((a, b) => a.i - b.i);
			entryErrors.sort((a, b) => a.i - b.i);
			const messages = [
				...uploadFailures.map(({ i }) => t("files.uploadFailedError", { name: files[i].name })),
				...entryErrors.map(({ i, message }) => t("files.uploadEntryError", { name: files[i].name, message })),
			];
			setUploadError(messages.join(" "));
		}

		uploadAbortRef.current = null;
		setUploadState(null);
	}

	function cancelUpload() {
		uploadAbortRef.current?.abort();
	}

	function isValidDropTarget(targetId) {
		if (!draggedIds) return false;
		if (draggedIds.includes(targetId)) return false;
		const S = treeState.value;
		return !draggedIds.some((id) => targetInsideSubtree(S, id, targetId));
	}

	function handleRowDragStart(entry, e) {
		const ids = selected.has(entry.id) && selected.size > 1 ? [...selected] : [entry.id];
		setDraggedIds(ids);
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", entry.displayName);
	}

	function handleRowDragEnd() {
		setDraggedIds(null);
		setDragOverId(null);
	}

	function handleFolderDragOver(entry, e) {
		if (!isValidDropTarget(entry.id)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		if (dragOverId !== entry.id) setDragOverId(entry.id);
	}

	function handleFolderDragLeave(entry) {
		setDragOverId((cur) => (cur === entry.id ? null : cur));
	}

	async function handleFolderDrop(entry, e) {
		e.preventDefault();
		const ids = draggedIds;
		const valid = isValidDropTarget(entry.id);
		setDraggedIds(null);
		setDragOverId(null);
		if (!ids || !valid) return;
		for (const id of ids) {
			const result = await moveNode(id, entry.id);
			const message = errorMessage(result);
			if (message) {
				setError(message);
				return;
			}
		}
		setError("");
		setSelected(new Set());
	}

	function openShareDialog(nodeId) {
		setShareDialogTarget(nodeId);
		setShareSelectedPubkeys(new Set());
		setShareError("");
	}

	function toggleShareRecipient(pubkey) {
		setShareSelectedPubkeys((prev) => {
			const next = new Set(prev);
			if (next.has(pubkey)) next.delete(pubkey);
			else next.add(pubkey);
			return next;
		});
	}

	async function submitShare() {
		if (shareSelectedPubkeys.size === 0) return;
		setShareBusy(true);
		setShareProgress(null);
		setShareError("");
		try {
			const result = await shareFolder(ownerPubkey, privKeySig.value, dbKeySig.value, shareDialogTarget, [...shareSelectedPubkeys], publish, {
				serverUrl: uploadTarget(),
				privateKey: privKeySig.value,
				onShareProgress: setShareProgress,
			});
			if (result instanceof Error) {
				setShareError(translateErrorMessage(result) || t("files.shareFailedGeneric"));
				return;
			}
			setShareDialogTarget(null);
		} catch (err) {
			// Настоящая причина (квота, отказ relay, сеть), а не всегда «сеть недоступна».
			setShareError(err?.key || err?.message ? translateErrorMessage(err) : t("files.networkUnavailable"));
		} finally {
			setShareBusy(false);
			setShareProgress(null);
		}
	}

	async function openAccessPanel(nodeId) {
		setAccessPanelTarget(nodeId);
		setGrantees(await listGrantees(ownerPubkey, nodeId));
	}

	async function handleRevoke(nodeId, pubkey) {
		await revokeAccess(ownerPubkey, privKeySig.value, dbKeySig.value, nodeId, pubkey, publish);
		setGrantees(await listGrantees(ownerPubkey, nodeId));
	}

	async function openMountView(mountId) {
		await ensureMountProjection(ownerPubkey, mountId);
		setOpenMountId(mountId);
		setMountFolderId(ROOT_ID);
	}

	async function handleSaveToOwn(mountId, nodeId) {
		setSaveProgress({ filesDone: 0, filesTotal: 1 });
		try {
			await saveMountedItemToOwn(ownerPubkey, dbKeySig.value, mountId, nodeId, currentFolderId.value, {
				serverUrl: uploadTarget(),
				privateKey: privKeySig.value,
				onProgress: (p) => setSaveProgress(p),
			});
		} finally {
			setSaveProgress(null);
		}
	}

	async function handleUnmountShare(mountId) {
		if (!window.confirm(t("files.unmountConfirm"))) return;
		await unmountShare(ownerPubkey, dbKeySig.value, mountId);
		if (openMountId === mountId) setOpenMountId(null);
	}

	// Дебаунс — по прецеденту chat.jsx (черновики): таймер, отменяется при
	// следующем нажатии/размонтировании. ALGO.MD §13: линейный скан — Θ(n)
	// на нажатие, при n=10⁴ порядка миллисекунды, строить индекс незачем;
	// дебаунс нужен, только чтобы не пересчитывать список на КАЖДЫЙ символ.
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(searchInput), FILTER_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [searchInput]);

	// Смена папки — фильтр предыдущей папки не должен молча продолжать
	// действовать в новой (пользователь его не видит, но список пуст без
	// объяснения — читалось бы как баг).
	useEffect(() => {
		setSearchInput("");
		setDebouncedQuery("");
	}, [currentFolderId.value]);

	const layout = layoutFor(typeFilter, viewOverride);
	const folderEntries = currentEntries.value;
	const baseEntries = filterEntries(filterByClass(folderEntries, typeFilter), debouncedQuery);
	// Порядок без размеров (по имени/типу) — дёшево; по размеру нужны манифесты ВСЕХ файлов папки.
	const sortedNoSize = sortEntries(baseEntries, sortKey === "size" ? "name" : sortKey, sortDir);
	const path = breadcrumbPath.value;
	const inTrash = currentFolderId.value === TRASH_ID;
	const classArr = treeState.value.classCount.get(currentFolderId.value);
	const typeCounts = {
		all: folderEntries.length,
		audio: classArr?.[0] ?? 0,
		video: classArr?.[1] ?? 0,
		image: classArr?.[2] ?? 0,
		other: classArr?.[3] ?? 0,
	};

	// Виртуализация (задача 3.2 TASK.md): "папка на 10⁴ элементов не
	// рендерится целиком". Рендерятся только entries[start:end] — окно
	// строк, видимое (+overscan) в единственной скролл-зоне экрана.
	const { anchorRef, start: windowStart, end: windowEnd } = useVirtualWindow({
		count: baseEntries.length,
		rowHeight: ROW_HEIGHT_PX,
	});
	// Размеры/типы из манифестов: видимому окну — всегда, целой папке — только при сортировке по размеру.
	const manifestInfo = useManifestInfo(
		ownerPubkey,
		(sortKey === "size" ? baseEntries : sortedNoSize.slice(windowStart, windowEnd)).filter((e) => e.kind === "file"),
		uploadTarget(),
	);
	const entries =
		sortKey === "size" ? sortEntries(baseEntries.map((e) => (e.kind === "file" ? { ...e, size: manifestInfo[e.id]?.size ?? 0 } : e)), "size", sortDir) : sortedNoSize;
	const visibleEntries = entries.slice(windowStart, windowEnd);

	function changeSort(key) {
		if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		else {
			setSortKey(key);
			setSortDir("asc");
		}
	}

	function toggleSelect(id) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	async function handleCreateFolder(e) {
		e.preventDefault();
		const name = newFolderName.trim();
		if (!name) return;
		const result = await createFolder(name);
		const message = errorMessage(result);
		if (message) {
			setError(message);
			return;
		}
		setError("");
		setNewFolderName("");
		setNewFolderOpen(false);
	}

	function startRename(entry) {
		setRenamingId(entry.id);
		setRenameValue(entry.displayName);
		setError("");
	}

	async function submitRename(e) {
		e.preventDefault();
		const name = renameValue.trim();
		if (!name) return;
		const result = await renameNode(renamingId, name);
		const message = errorMessage(result);
		if (message) {
			setError(message);
			return;
		}
		setError("");
		setRenamingId(null);
	}

	async function resolveMediaRef(node) {
		let manifest = await getCachedManifest(ownerPubkey, node.blob);
		if (!manifest) {
			manifest = await getManifest(node.blob, { serverUrl: uploadTarget() });
			await putCachedManifest(ownerPubkey, node.blob, manifest);
		}
		if (node.mime == null) backfillMime(node.id, manifest.mime).catch(() => {});
		const fileKey = await getFileKeyFor(node.blob);
		if (!fileKey) return null;
		return {
			digest: node.blob,
			key: fileKey,
			mime: manifest.mime,
			name: manifest.name,
			size: manifest.size,
			sourceKind: "node",
			sourceMeta: { nodeId: node.id },
		};
	}

	async function openVisibleMedia(clickedId) {
		const { items, position } = buildVisibleMediaPlaylist(entries, clickedId);
		if (items.length === 0) return;
		setMediaButtonsBusy(true);
		setError("");
		try {
			const refs = [];
			for (const node of items) {
				const ref = await resolveMediaRef(node);
				if (!ref) {
					setError(t("chat.window.fileKeyNotFoundError"));
					return;
				}
				refs.push(ref);
			}
			openMedia({ refs, position });
		} catch (err) {
			setError(translateErrorMessage(err));
		} finally {
			setMediaButtonsBusy(false);
		}
	}

	async function openEntry(entry) {
		if (entry.kind === "dir") {
			openFolder(entry.id);
			setSelected(new Set());
			return;
		}
		if (entry.blob && freedDigests.value.has(entry.blob)) {
			setError(t("files.freedOpenHint", { name: entry.displayName }));
			return;
		}
		const cls = entry.mime ? classOf(entry.mime) : "other";
		if (cls === "audio" || cls === "video" || cls === "image") {
			await openVisibleMedia(entry.id);
			return;
		}
		try {
			const mediaRef = await resolveMediaRef(entry);
			if (!mediaRef) {
				setError(t("chat.window.fileKeyNotFoundError"));
				return;
			}
			setDocInfo({ entry, mediaRef });
		} catch (err) {
			setError(translateErrorMessage(err));
		}
	}

	function clearTypeFilter() {
		setTypeFilter("all");
	}

	function setLayoutForType(next) {
		if (typeFilter === "all") return;
		setViewOverride((prev) => ({ ...prev, [typeFilter]: next }));
	}

	// ТЗ-03, раздел 6: «освободить место» — стирает байты этого файла с сервера. Журнал
	// знает все блобы вложения; без журнала (новое устройство) берём то, что видно из
	// самого узла: манифест и содержимое.
	async function openFreeSpace(entry) {
		try {
			const group = await getGroupOfHash(entry.blob);
			if (group) {
				setFreeDialog({ hashes: group.rows.map((r) => r.hash), name: entry.displayName, size: group.rows.reduce((sum, r) => sum + r.size, 0), targets: group.rows.flatMap((r) => r.targets).filter((x, i, a) => a.indexOf(x) === i), inFiles: true });
				return;
			}
			const manifest = await getManifest(entry.blob, { serverUrl: uploadTarget() });
			setFreeDialog({ hashes: [entry.blob, manifest.blobSha256], name: entry.displayName, size: manifest.size, targets: [], inFiles: true });
		} catch (err) {
			setUploadError(translateErrorMessage(err));
		}
	}

	async function handleDelete(ids) {
		if (!window.confirm(ids.length > 1 ? t("files.moveManyToTrashConfirm", { count: ids.length }) : t("files.moveToTrashConfirm"))) return;
		for (const id of ids) await removeNode(id);
		setSelected(new Set());
	}

	async function handlePurge(id) {
		if (!window.confirm(t("files.purgeConfirm"))) return;
		await purgeNode(id);
	}

	async function handleRestore(id) {
		// Исходное расположение нигде не хранится отдельно (MATH.md: путь —
		// производная величина) — восстановление ведёт в корень, дальше
		// пользователь перемещает сам, если нужно другое место.
		await moveNode(id, ROOT_ID);
	}

	function copySelected() {
		if (selected.size === 0) return;
		copySelection([...selected]);
		setSelected(new Set());
	}
	function cutSelected() {
		if (selected.size === 0) return;
		cutSelection([...selected]);
		setSelected(new Set());
	}

	// §7 TASK.md: "работают Ctrl+C / Ctrl+X / Ctrl+V / Delete / F2 / Ctrl+Z".
	// Слушаем document, не files-shell: при входе в папку кнопка-имя
	// размонтируется и фокус уходит на body — иначе Ctrl+V молчит.
	// Игнорируем, если фокус в поле ввода (не перехватывать обычный текстовый
	// copy/paste пользователя внутри формы переименования/создания папки).
	useEffect(() => {
		function isTypingTarget(e) {
			const tag = e.target.tagName;
			return tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable;
		}
		function handleKeyDown(e) {
			if (isTypingTarget(e)) return;
			if (view !== "own" || inTrash) return;
			const mod = e.ctrlKey || e.metaKey;
			if (mod && e.key.toLowerCase() === "c") {
				if (selected.size === 0) return;
				e.preventDefault();
				copySelected();
			} else if (mod && e.key.toLowerCase() === "x") {
				if (selected.size === 0) return;
				e.preventDefault();
				cutSelected();
			} else if (mod && e.key.toLowerCase() === "v") {
				if (!clipboardHasContent.value) return;
				e.preventDefault();
				pasteHere();
			} else if (mod && e.key.toLowerCase() === "z") {
				e.preventDefault();
				undo();
			} else if (e.key === "Delete" || e.key === "Backspace") {
				if (selected.size > 0) {
					e.preventDefault();
					handleDelete([...selected]);
				}
			} else if (e.key === "F2") {
				if (selected.size === 1) {
					const [id] = selected;
					const entry = entries.find((en) => en.id === id);
					if (entry) {
						e.preventDefault();
						startRename(entry);
					}
				}
			}
		}
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	});

	function openRowActionsMenu(e) {
		const details = e.currentTarget.querySelector("details.menu");
		if (!details) return;
		e.preventDefault();
		details.open = true;
	}

	if (!ready) return null;

	return (
		<>
		<Screen
			// Внутри полученной доли — стрелка «назад» перед заголовком (вместо кнопки «К списку долей» в теле).
			breadcrumb={view === "mounts" && openMountId !== null ? { label: t("files.receivedFoldersTab"), onBack: () => setOpenMountId(null) } : undefined}
			// Живой фидбег: пункт меню назывался "Хранилище", а сюда попадали на
			// экран "Файлы" — разнобой в названии одного и того же места.
			// sidebarCard.storageMenuItem переименован в "Файлы" (account-card.jsx),
			// плюс имя пользователя — тот же приём, что "Профиль и аватар"/
			// "Секретная фраза".
			title={path[path.length - 1]?.name || t("nav.files")}
			actions={
				<>
					{view === "own" && (
						<>
							<button type="button" class="bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }} onClick={triggerFileUpload} disabled={!!uploadState} aria-label={t("files.uploadFileButton")} title={t("files.uploadFileButton")}>
								<IconUpload aria-hidden="true" /> <span class="btn-label">{t("files.uploadFileButton")}</span>
							</button>
							<button type="button" class="btn--ghost bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }} onClick={() => setNewFolderOpen((v) => !v)} aria-label={t("files.newFolderButton")} title={t("files.newFolderButton")}>
								<IconFolderPlus aria-hidden="true" /> <span class="btn-label">{t("files.newFolderButton")}</span>
							</button>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								onChange={handleFilesSelected}
								style={{ display: "none" }}
								aria-label={t("files.selectFilesAria")}
							/>
						</>
					)}
					<button
						type="button"
						class={(view === "mounts" ? "" : "btn--ghost ") + "bar"}
						style={{ "--gap": "var(--space-2xs)", "--align": "center" }}
						aria-pressed={view === "mounts"}
						aria-label={t("files.receivedFoldersTab")}
						title={t("files.receivedFoldersTab")}
						onClick={() => setView((v) => (v === "mounts" ? "own" : "mounts"))}
					>
						<IconGlobe aria-hidden="true" /> <span class="btn-label">{t("files.receivedFoldersTab")}</span>
						{activeMounts.value.length > 0 ? <span class="slice__n">{activeMounts.value.length}</span> : null}
					</button>
					{view === "own" && !inTrash && (
						<button type="button" class="icon-btn" onClick={() => openFolder(TRASH_ID)} aria-label={t("files.trashButton")} title={t("files.trashButton")}>
							<IconTrash />
						</button>
					)}
					{view === "own" && clipboardHasContent.value && !inTrash && (
						<button
							type="button"
							class="btn--ghost bar"
							style={{ "--gap": "var(--space-2xs)", "--align": "center" }}
							onClick={() => pasteHere()}
						>
							{t("files.pasteButton", { count: clipboard.value.selection.length })}
						</button>
					)}
					{view === "own" && canUndo.value && (
						<button type="button" class="icon-btn" onClick={undo} aria-label={t("common.undo")} title={t("common.undo")}>
							<IconRestore />
						</button>
					)}
				</>
			}
			slices={
				view === "own" ? (
					<TypeFilterBar counts={typeCounts} active={typeFilter} onSelect={setTypeFilter} />
				) : null
			}
		>
			{view === "mounts" ? (
				<MountsView
					openMountId={openMountId}
					mountFolderId={mountFolderId}
					setMountFolderId={setMountFolderId}
					openMountView={openMountView}
					closeMountView={() => setOpenMountId(null)}
					handleSaveToOwn={handleSaveToOwn}
					handleUnmountShare={handleUnmountShare}
					saveProgress={saveProgress}
				/>
			) : (
			<div ref={containerRef} tabIndex={-1} class="files-shell stack" style={{ "--gap": "var(--space-m)" }}>
				{path.length > 1 && (
					<nav class="row file-breadcrumbs" style={{ "--gap": "var(--space-3xs)", "--align": "center" }} aria-label={t("files.breadcrumbAria")}>
						{path.map((crumb, i) => (
							<span key={crumb.id} class="row" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
								{i > 0 && <IconChevronRight aria-hidden="true" />}
								{i === path.length - 1 ? (
									<span>{crumb.name}</span>
								) : (
									<button type="button" class="btn--ghost" onClick={() => openFolder(crumb.id)}>
										{crumb.name}
									</button>
								)}
							</span>
						))}
					</nav>
				)}

				{typeFilter !== "all" && TYPE_MODE[typeFilter] && (
					<div class="mode-bar row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						<span class="mode-bar__title bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
							{(() => {
								const Icon = TYPE_MODE[typeFilter].Icon;
								return <Icon aria-hidden="true" />;
							})()}
							{t(TYPE_MODE[typeFilter].labelKey)}
						</span>
						<span class="mode-bar__n">{tPlural("files.fileCount", entries.length)}</span>
						<span class="grow" />
						{TYPE_MODE[typeFilter].playKey && entries.some((e) => e.kind === "file") && (
							<button
								type="button"
								class="btn--ghost bar rigid"
								style={{ "--gap": "var(--space-2xs)", "--align": "center" }}
								onClick={() => openVisibleMedia(null)}
								disabled={mediaButtonsBusy}
							>
								{mediaButtonsBusy && <span class="spinner" aria-hidden="true" />}
								<IconPlayerPlay aria-hidden="true" /> {t(TYPE_MODE[typeFilter].playKey)}
							</button>
						)}
						<div class="seg view-toggle bar rigid" style={{ "--gap": 0 }} role="group" aria-label={t("files.viewToggleAria")}>
							<button
								type="button"
								class={"slice bar rigid" + (layout === "list" ? " slice--on" : "")}
								aria-label={t("files.viewListAria")}
								aria-pressed={layout === "list"}
								title={t("files.viewListAria")}
								onClick={() => setLayoutForType("list")}
							>
								<IconViewList />
							</button>
							<button
								type="button"
								class={"slice bar rigid" + (layout === "grid" ? " slice--on" : "")}
								aria-label={t("files.viewGridAria")}
								aria-pressed={layout === "grid"}
								title={t("files.viewGridAria")}
								onClick={() => setLayoutForType("grid")}
							>
								<IconSquaresFour />
							</button>
						</div>
						<button type="button" class="icon-btn rigid" aria-label={t("files.clearTypeFilterAria")} onClick={clearTypeFilter}>
							<IconCross />
						</button>
					</div>
				)}

				<div class="file-search-field row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					<IconMagnifyingGlass aria-hidden="true" />
					<label class="visually-hidden" for="file-search">
						{t("files.filterLabel")}
					</label>
					<input
						id="file-search"
						type="search"
						class="grow"
						value={searchInput}
						onInput={(e) => setSearchInput(e.currentTarget.value)}
						placeholder={t("files.searchPlaceholder")}
					/>
				</div>

				{clipboardHasContent.value && !inTrash && (
					<div class="row file-selection-toolbar" style={{ "--gap": "var(--space-s)", "--align": "center" }} role="status">
						<span>
							{clipboard.value.state === "cut"
								? t("files.clipboardCut", { count: clipboard.value.selection.length })
								: t("files.clipboardCopied", { count: clipboard.value.selection.length })}
						</span>
						<button type="button" class="bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }} onClick={() => pasteHere()}>
							{t("files.pasteHere")}
						</button>
						<button type="button" class="btn--ghost" onClick={cancelSelection}>
							{t("common.cancel")}
						</button>
					</div>
				)}

				{newFolderOpen && (
					<form class="row file-new-folder-form" style={{ "--gap": "var(--space-s)", "--align": "center" }} onSubmit={handleCreateFolder}>
						<label class="visually-hidden" for="new-folder-name">
							{t("files.folderNameLabel")}
						</label>
						<input id="new-folder-name" type="text" value={newFolderName} onInput={(e) => setNewFolderName(e.currentTarget.value)} placeholder={t("files.folderNameLabel")} autoFocus />
						<button type="submit">{t("common.create")}</button>
						<button type="button" class="btn--ghost" onClick={() => setNewFolderOpen(false)}>
							{t("common.cancel")}
						</button>
					</form>
				)}
				{error && (
					<p role="alert" style={{ color: "var(--bad)" }}>
						{error}
					</p>
				)}
				{uploadState && (
					<div class="row file-upload-progress" style={{ "--gap": "var(--space-s)", "--align": "center" }} role="status">
						<span>{uploadProgressText(uploadState)}</span>
						<button type="button" class="btn--ghost" onClick={cancelUpload}>
							{t("common.undo")}
						</button>
					</div>
				)}
				{uploadError && (
					<p role="alert" style={{ color: "var(--bad)" }}>
						{uploadError}
					</p>
				)}

				{selected.size > 0 && (
					<div class="row file-selection-toolbar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						<span>{t("files.selectionCount", { count: selected.size })}</span>
						<button type="button" class="btn--ghost" onClick={copySelected}>
							<IconCopy /> {t("common.copy")}
						</button>
						<button type="button" class="btn--ghost" onClick={cutSelected}>
							<IconScissors /> {t("files.cutButton")}
						</button>
						<button type="button" class="btn--ghost btn--danger" onClick={() => handleDelete([...selected])}>
							<IconTrash /> {t("common.delete")}
						</button>
						<button type="button" class="btn--ghost" onClick={() => setSelected(new Set())}>
							{t("files.clearSelectionButton")}
						</button>
					</div>
				)}

				{entries.length === 0 ? (
					<div class="stack" style={{ "--gap": "var(--space-s)" }}>
						<p style={{ color: "var(--muted)" }}>
							{inTrash ? t("files.trashEmpty") : typeFilter !== "all" ? t("files.typeEmpty") : t("files.folderEmpty")}
						</p>
						{!inTrash && clipboardHasContent.value && typeFilter === "all" && (
							<button type="button" class="btn--ghost bar" style={{ "--gap": "var(--space-2xs)", "--align": "center", alignSelf: "start" }} onClick={() => pasteHere()}>
								{t("files.pasteHere")}
							</button>
						)}
					</div>
				) : layout === "grid" ? (
					<ul role="list" class="file-grid">
						{entries.map((entry) => (
							<li key={entry.id} class="file-tile" onContextMenu={openRowActionsMenu}>
								{/* Найдено пользователем — плитка (сама картинка/иконка) была
								    некликабельна, открывал файл только текстовый подпись-линк
								    ПОД ней (легко не заметить) — "кликаешь по ним и ничего".
								    Тот же обработчик, что у file-tile__name ниже. */}
								<button
									type="button"
									class="file-tile__frame"
									onClick={(e) => {
										if (entry.kind !== "dir") setMediaOrigin(e.currentTarget.getBoundingClientRect());
										openEntry(entry);
									}}
								>
									{entry.kind === "dir" ? (
										<IconFolder aria-hidden="true" class="icon" />
									) : (
										<FileThumbnail entry={entry} ownerPubkey={ownerPubkey} imgClass="" maxDimension={TILE_THUMBNAIL_SIZE} />
									)}
								</button>
								{!inTrash && (
									<div class="file-tile__menu" onClick={(e) => e.stopPropagation()}>
										<ActionsMenu label={t("files.rowActionsAria", { name: entry.displayName })}>
											<button type="button" onClick={() => startRename(entry)}>
												<IconPencil /> {t("contacts.renameAction")}
											</button>
											<button type="button" onClick={() => copySelection([entry.id])}>
												<IconCopy /> {t("common.copy")}
											</button>
											<button type="button" onClick={() => cutSelection([entry.id])}>
												<IconScissors /> {t("files.cutButton")}
											</button>
											{entry.kind === "dir" && clipboardHasContent.value && !clipboard.value.selection.includes(entry.id) && (
												<button type="button" onClick={() => pasteHere(entry.id)}>
													{t("files.pasteInto")}
												</button>
											)}
											{entry.kind === "dir" &&
												(sharedNodeIds.value.has(entry.id) ? (
													<button type="button" onClick={() => openAccessPanel(entry.id)}>
														<IconGlobe /> {t("files.manageAccessButton")}
													</button>
												) : (
													<button type="button" onClick={() => openShareDialog(entry.id)}>
														<IconGlobe /> {t("files.shareButton")}
													</button>
												))}
											{entry.kind === "file" && (
												<button type="button" onClick={() => openFreeSpace(entry)}>
													<IconEmpty /> {t("storage.free.button")}
												</button>
											)}
											<button type="button" class="danger" onClick={() => handleDelete([entry.id])}>
												<IconTrash /> {t("common.delete")}
											</button>
										</ActionsMenu>
									</div>
								)}
								<button
									type="button"
									class="file-tile__name truncate"
									style={{ "--lines": 1 }}
									onClick={(e) => {
										if (entry.kind !== "dir") setMediaOrigin(e.currentTarget.getBoundingClientRect());
										openEntry(entry);
									}}
								>
									{entry.displayName}
								</button>
								<FileMetaLabel entry={entry} ownerPubkey={ownerPubkey} class="file-tile__meta" />
							</li>
						))}
					</ul>
				) : (
					<>
						<div ref={anchorRef} aria-hidden="true" />
						<table class={"file-table" + (inTrash ? " file-table--trash" : "")}>
							<FileTableHead sortKey={sortKey} sortDir={sortDir} onSort={changeSort} />
							<tbody>
								{windowStart > 0 && (
									<tr class="file-table__spacer" aria-hidden="true" style={{ height: `${windowStart * ROW_HEIGHT_PX}px` }}>
										<td colSpan={6} />
									</tr>
								)}
								{visibleEntries.map((entry) => (
									<tr
										key={entry.id}
										class={"file-row" + (dragOverId === entry.id ? " file-row--drag-over" : "")}
										onContextMenu={openRowActionsMenu}
										draggable={!inTrash && renamingId !== entry.id}
										onDragStart={(e) => handleRowDragStart(entry, e)}
										onDragEnd={handleRowDragEnd}
										onDragOver={entry.kind === "dir" ? (e) => handleFolderDragOver(entry, e) : undefined}
										onDragLeave={entry.kind === "dir" ? () => handleFolderDragLeave(entry) : undefined}
										onDrop={entry.kind === "dir" ? (e) => handleFolderDrop(entry, e) : undefined}
									>
										<td class="file-table__icon">
											{entry.kind === "dir" ? <IconFolder aria-hidden="true" class="icon file-row-icon" /> : <FileThumbnail entry={entry} ownerPubkey={ownerPubkey} />}
										</td>
										<td>
											{renamingId === entry.id ? (
												<form class="row file-rename-form" style={{ "--gap": "var(--space-s)", "--align": "center" }} onSubmit={submitRename}>
													<label class="visually-hidden" for={`rename-${entry.id}`}>
														{t("files.newNameLabel")}
													</label>
													<input id={`rename-${entry.id}`} type="text" value={renameValue} onInput={(e) => setRenameValue(e.currentTarget.value)} autoFocus />
													<button type="submit" class="icon-btn" aria-label={t("common.save")}>
														<IconCheck />
													</button>
													<button type="button" class="icon-btn" onClick={() => setRenamingId(null)} aria-label={t("files.cancelRenameAria")}>
														<IconCross />
													</button>
												</form>
											) : (
												<button
													type="button"
													class="file-row-name"
													title={entry.displayName}
													onClick={(e) => {
														if (entry.kind !== "dir") setMediaOrigin(e.currentTarget.getBoundingClientRect());
														openEntry(entry);
													}}
												>
													<span class="file-row-title">{entry.displayName}</span>
													<small class="file-row-sub">
														{entry.kind === "dir" ? t("files.kindFolder") : fileExtLabel(entry.displayName)}
														{manifestInfo[entry.id]?.size ? ` · ${formatFileSize(manifestInfo[entry.id].size)}` : ""}
													</small>
												</button>
											)}
										</td>
										<td class="file-table__type">
											<small class="file-row-status">{entry.kind === "dir" ? t("files.kindFolder") : fileExtLabel(entry.displayName)}</small>
										</td>
										<td class="file-table__size">
											<FileSizeCell entry={entry} size={manifestInfo[entry.id]?.size} />
										</td>
										<td class="file-table__access">
											{entry.kind === "dir" && sharedNodeIds.value.has(entry.id) && (
												<IconGlobe aria-hidden="true" title={t("files.sharedTooltip")} class="icon file-row-icon file-row-icon--shared" />
											)}
										</td>
										<td class="file-table__actions">
											{inTrash ? (
												<>
													<button type="button" class="btn--ghost" onClick={() => handleRestore(entry.id)} aria-label={t("files.restoreButton")} title={t("files.restoreButton")}>
														<IconRestore /> <span class="slice__label">{t("files.restoreButton")}</span>
													</button>
													<button type="button" class="btn--ghost btn--danger" onClick={() => handlePurge(entry.id)} aria-label={t("files.purgeButton")} title={t("files.purgeButton")}>
														<IconTrash /> <span class="slice__label">{t("files.purgeButton")}</span>
													</button>
												</>
											) : (
									<ActionsMenu label={t("files.rowActionsAria", { name: entry.displayName })}>
										<button type="button" onClick={() => startRename(entry)}>
											<IconPencil /> {t("contacts.renameAction")}
										</button>
										<button type="button" onClick={() => copySelection([entry.id])}>
											<IconCopy /> {t("common.copy")}
										</button>
										<button type="button" onClick={() => cutSelection([entry.id])}>
											<IconScissors /> {t("files.cutButton")}
										</button>
										{entry.kind === "dir" && clipboardHasContent.value && !clipboard.value.selection.includes(entry.id) && (
											<button type="button" onClick={() => pasteHere(entry.id)}>
												{t("files.pasteInto")}
											</button>
										)}
										{entry.kind === "dir" && (
											sharedNodeIds.value.has(entry.id) ? (
												<button type="button" onClick={() => openAccessPanel(entry.id)}>
													<IconGlobe /> {t("files.manageAccessButton")}
												</button>
											) : (
												<button type="button" onClick={() => openShareDialog(entry.id)}>
													<IconGlobe /> {t("files.shareButton")}
												</button>
											)
										)}
										{entry.kind === "file" && (
											<button type="button" onClick={() => openFreeSpace(entry)}>
													<IconEmpty /> {t("storage.free.button")}
												</button>
										)}
										<button type="button" class="danger" onClick={() => handleDelete([entry.id])}>
											<IconTrash /> {t("common.delete")}
										</button>
									</ActionsMenu>
											)}
										</td>
									</tr>
								))}
								{windowEnd < entries.length && (
									<tr class="file-table__spacer" aria-hidden="true" style={{ height: `${(entries.length - windowEnd) * ROW_HEIGHT_PX}px` }}>
										<td colSpan={6} />
									</tr>
								)}
							</tbody>
						</table>
					</>
				)}
			</div>
			)}
		</Screen>
		{freeDialog && <FreeSpaceDialog {...freeDialog} serverUrl={uploadTarget()} privKey={privKeySig.value} onClose={() => setFreeDialog(null)} onDone={() => refreshFreed()} />}
		{shareDialogTarget && (
			<ShareDialog
				busy={shareBusy}
				progress={shareProgress}
				error={shareError}
				selected={shareSelectedPubkeys}
				onToggle={toggleShareRecipient}
				onSubmit={submitShare}
				onCancel={() => setShareDialogTarget(null)}
			/>
		)}
		{accessPanelTarget && (
			<AccessPanel grantees={grantees} onRevoke={(pubkey) => handleRevoke(accessPanelTarget, pubkey)} onClose={() => setAccessPanelTarget(null)} />
		)}
		{docInfo && (
			<FileInfoDialog entry={docInfo.entry} mediaRef={docInfo.mediaRef} onClose={() => setDocInfo(null)} />
		)}
		</>
	);
}

function ModalShell({ label, onClose, children }) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={label}
			onClick={onClose}
			style={{ position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "var(--space-m)" }}
		>
			<div onClick={(e) => e.stopPropagation()} class="stack" style={{ background: "var(--surface, canvas)", borderRadius: "var(--radius)", padding: "var(--space-m)", maxWidth: "32rem", width: "100%", maxHeight: "80vh", overflowY: "auto" }}>
				{children}
			</div>
		</div>
	);
}

// Диалог "Поделиться" (этап 53 И6, задача 6.7) — выбор контактов чекбоксами.
// share() в v0.1 производит только read-гранты (CONTRACTS.md 6.2) — второй
// уровень доступа выбирать не из чего, поэтому его в интерфейсе просто нет.
function ShareDialog({ busy, progress, error, selected, onToggle, onSubmit, onCancel }) {
	return (
		<ModalShell label={t("files.shareButton")} onClose={onCancel}>
			<h2>{t("files.shareButton")}</h2>
			<p style={{ color: "var(--muted)" }}>{t("files.shareDialogHint")}</p>
			{contacts.value.length === 0 ? (
				<p>{t("contacts.noContactsAtAll")}</p>
			) : (
				<ul role="list" class="stack">
					{contacts.value.map((pubkey) => (
						<li key={pubkey} class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
							<label class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
								<input type="checkbox" checked={selected.has(pubkey)} onChange={() => onToggle(pubkey)} />
								{profiles.value[pubkey]?.name || pubkey.slice(0, 16)}
							</label>
						</li>
					))}
				</ul>
			)}
			{busy && (
				<div role="status" class="stack" style={{ "--gap": "var(--space-2xs)" }}>
					<progress max="100" value={progress ? Math.round(progress.fraction * 100) : undefined} style={{ width: "100%" }} />
					<small style={{ color: "var(--muted)" }}>
						{progress && progress.total > 0
							? t("files.shareProgress", { done: Math.min(progress.done + (progress.done < progress.total ? 1 : 0), progress.total), total: progress.total, percent: Math.round(progress.fraction * 100), name: progress.name })
							: t("files.shareProgressStart")}
					</small>
				</div>
			)}
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<button type="button" disabled={busy || selected.size === 0} onClick={onSubmit}>
					{busy ? t("files.uploading") : t("files.shareButton")}
				</button>
				<button type="button" class="btn--ghost" onClick={onCancel}>
					{t("common.cancel")}
				</button>
			</div>
		</ModalShell>
	);
}

// Панель "Управление доступом" — список текущих читателей + отзыв.
function AccessPanel({ grantees, onRevoke, onClose }) {
	return (
		<ModalShell label={t("files.manageAccessButton")} onClose={onClose}>
			<h2>{t("files.manageAccessButton")}</h2>
			{grantees.length === 0 ? (
				<p>{t("files.noAccessGranted")}</p>
			) : (
				<ul role="list" class="stack">
					{grantees.map((pubkey) => (
						<li key={pubkey} class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
							<IconPeople aria-hidden="true" />
							<span class="grow">{profiles.value[pubkey]?.name || pubkey.slice(0, 16)}</span>
							<button type="button" class="btn--ghost btn--danger" onClick={() => onRevoke(pubkey)}>
								{t("files.revokeButton")}
							</button>
						</li>
					))}
				</ul>
			)}
			<button type="button" class="btn--ghost" onClick={onClose}>
				{t("common.close")}
			</button>
		</ModalShell>
	);
}

