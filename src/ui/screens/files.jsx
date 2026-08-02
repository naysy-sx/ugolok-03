import { useState, useEffect, useRef } from "preact/hooks";
import Screen from "../components/screen.jsx";
import ActionsMenu from "../components/actions-menu.jsx";
import IconFolder from "../icons/folder.jsx";
import IconPlus from "../icons/plus.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconTrash from "../icons/trash.jsx";
import IconCopy from "../icons/copy.jsx";
import IconChevronRight from "../icons/chevron-right.jsx";
import IconFileText from "../icons/file-text.jsx";
import IconCheck from "../icons/check.jsx";
import IconCross from "../icons/cross.jsx";
import { currentUser, privKeySig } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import {
	initFiles,
	currentFolderId,
	currentEntries,
	breadcrumbPath,
	clipboard,
	canUndo,
	createFolder,
	createFileEntry,
	renameNode,
	removeNode,
	purgeNode,
	moveNode,
	copySelection,
	cutSelection,
	pasteHere,
	undo,
	openFolder,
	getFileKeyFor,
	treeState,
} from "../signals/files.js";
import { sharedNodeIds, initShares, shareFolder, revokeAccess, listGrantees } from "../signals/shares.js";
import { activeMounts, mountProjections, ensureMountProjection, saveMountedItemToOwn, unmountShare } from "../signals/mounts.js";
import { contacts, profiles } from "../signals/contacts.js";
import { dbKeySig } from "../signals/auth.js";
import { ROOT_ID, TRASH_ID, LOST_FOUND_ID } from "../../domain/files/tree.js";
import { sortEntries } from "../../domain/files/sort.js";
import { filterEntries } from "../../domain/files/filter.js";
import { PreconditionError, targetInsideSubtree } from "../../domain/files/ops.js";
import { getManifest, getRange, putStream } from "../../domain/files/content.js";
import { getCachedManifest, putCachedManifest } from "../../domain/files/store.js";
import { isThumbnailable, createThumbnailBlob } from "../../domain/files/thumbnails.js";
import { createThumbnailQueue } from "../../domain/files/thumbnail-queue.js";
import { getMemoryCachedUrl, putMemoryCachedAttachment } from "../attachment-memory-cache.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import IconMagnifyingGlass from "../icons/magnifying-glass.jsx";
import IconGlobe from "../icons/globe.jsx";
import IconPeople from "../icons/people.jsx";
import IconPaperclip from "../icons/paperclip.jsx";
import { useVirtualWindow } from "../hooks/use-virtual-window.js";
import FilePlayer from "../components/file-player.jsx";
import { t } from "../signals/i18n.js";

const FILTER_DEBOUNCE_MS = 150; // ALGO.MD §13 — "дебаунс в 100-150 мс"
const ROW_HEIGHT_PX = 56; // = --file-row-height в custom.css, держать в синхроне
const BLOSSOM_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];
// Общая на весь экран очередь — иначе каждая строка получила бы СВОЙ
// параллелизм, и общее число одновременных задач росло бы с числом видимых
// строк, а не оставалось 2-4 (ALGO.MD §15).
const thumbnailQueue = createThumbnailQueue(3);

// Миниатюра по видимости (IntersectionObserver) — задача 3.8 TASK.md.
// Манифест (mime/size) неизвестен из самого узла дерева (Node.blob — только
// дайджест, §4.1 TASK.md) — приходится сходить за ним (кэш в files_manifests,
// store.js, сперва; сеть — только если кэш пуст). Отмена — если строка
// покинула вьюпорт РАНЬШЕ, чем задание стартовало (thumbnail-queue.js);
// уже стартовавшее докручивается, не прерывается на середине.
// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 53 И7 4.4-довесок): "отправитель видит
// маленькую фотку, получатель — нормальную". Причина — ключ кэша здесь
// (entry.blob = manifestDigest) СОВПАДАЛ с ключом, которым attachment-
// view.jsx кэширует ПОЛНОРАЗМЕРНОЕ вложение чата (тот же manifestDigest,
// если файл был отправлен через дедупликацию, И7 7.4 — один и тот же
// блоб). Миниатюра (200px, downscale) — не то же самое содержимое, что
// полный файл, но раньше делила с ним ОДИН слот в attachment-memory-
// cache.js — кто первым закэшировал (превью в "Файлы" или полный
// просмотр в чате), тот и "выигрывал" для ВСЕХ последующих чтений под
// этим digest'ом. THUMB_CACHE_PREFIX — отдельный неймспейс, чтобы
// уменьшенная и полная версии никогда не делили один ключ.
const THUMB_CACHE_PREFIX = "thumb:";

function FileThumbnail({ entry, ownerPubkey }) {
	const [url, setUrl] = useState(() => getMemoryCachedUrl(THUMB_CACHE_PREFIX + entry.blob) ?? null);
	const [failed, setFailed] = useState(false);
	const elRef = useRef(null);

	useEffect(() => {
		if (url || failed || !entry.blob) return;
		let handle = null;
		let cancelled = false;

		const observer = new IntersectionObserver(([observedEntry]) => {
			if (observedEntry.isIntersecting && !handle) {
				handle = thumbnailQueue.enqueue(async () => {
					let manifest = await getCachedManifest(ownerPubkey, entry.blob);
					if (!manifest) {
						manifest = await getManifest(entry.blob, { serverUrl: BLOSSOM_URL });
						await putCachedManifest(ownerPubkey, entry.blob, manifest);
					}
					if (!isThumbnailable(manifest.mime)) return null;
					const fileKey = await getFileKeyFor(entry.blob);
					if (!fileKey) return null; // ключ ещё не персистирован/не наш файл
					const bytes = await getRange(manifest, fileKey, 0, manifest.size, { serverUrl: BLOSSOM_URL });
					return createThumbnailBlob(bytes, manifest.mime);
				});
				handle.promise
					.then((thumbBytes) => {
						if (cancelled) return;
						if (!thumbBytes) {
							setFailed(true);
							return;
						}
						setUrl(putMemoryCachedAttachment(THUMB_CACHE_PREFIX + entry.blob, thumbBytes, "image/jpeg"));
					})
					.catch(() => {
						if (!cancelled) setFailed(true);
					});
			} else if (!observedEntry.isIntersecting && handle) {
				handle.cancel();
				handle = null;
			}
		});
		if (elRef.current) observer.observe(elRef.current);

		return () => {
			cancelled = true;
			observer.disconnect();
			handle?.cancel();
		};
	}, [entry.blob, url, failed]);

	if (url) return <img src={url} alt="" class="file-row-thumb" />;
	// ref — на обычный <span>, не напрямую на иконку: IconFileText — простой
	// функциональный компонент без forwardRef, ref на него не долетает до
	// настоящего DOM-узла (найдено живой проверкой — IntersectionObserver
	// падал на не-Element). Span визуально прозрачен (inline, без своих
	// стилей), просто держит точку наблюдения.
	return (
		<span ref={elRef} style={{ display: "inline-flex" }}>
			<IconFileText aria-hidden="true" class="file-row-icon" />
		</span>
	);
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
	return result instanceof PreconditionError ? result.message : null;
}

// Пока БЕЗ виртуализации (задача 3.2) и миниатюр (3.8) — вторая волна
// добавила фильтр (3.7). Файлы (в отличие от папок) показывают общую
// иконку — размер/mime живут в манифесте (content.js), не в самом узле
// дерева; подгрузка манифеста по каждой строке — из той же серии, что
// миниатюры, следующим шагом (3.8), не задача этого прохода.
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
	const [playingDigest, setPlayingDigest] = useState(null);
	const containerRef = useRef(null);

	// 6.7 (сужение MVP, CONTRACTS.md) — "Полученные доли" ОТДЕЛЬНЫЙ раздел,
	// своя локальная навигация (mountFolderId), не смешивается с основным
	// деревом/буфером обмена/undo (read-only с точки зрения UI — share() в
	// v0.1 производит только read-гранты).
	const [view, setView] = useState("own"); // "own" | "mounts"
	const [shareDialogTarget, setShareDialogTarget] = useState(null); // nodeId папки
	const [shareSelectedPubkeys, setShareSelectedPubkeys] = useState(() => new Set());
	const [shareBusy, setShareBusy] = useState(false);
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
	const [uploadState, setUploadState] = useState(null); // {fileName, fileIndex, filesTotal, chunksDone, chunksTotal} | null
	const [uploadError, setUploadError] = useState("");
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

	async function handleFilesSelected(e) {
		const files = [...e.target.files];
		e.target.value = ""; // тот же файл повторно — иначе повторный выбор того же файла не даст onChange
		if (files.length === 0) return;
		setUploadError("");
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const controller = new AbortController();
			uploadAbortRef.current = controller;
			setUploadState({ fileName: file.name, fileIndex: i + 1, filesTotal: files.length, chunksDone: 0, chunksTotal: 1 });
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const { manifestDigest, fileKey } = await putStream(bytes, {
					name: file.name,
					mime: file.type || "application/octet-stream",
					serverUrl: BLOSSOM_URL,
					privateKey: privKeySig.value,
					signal: controller.signal,
					onProgress: (p) => setUploadState((prev) => (prev ? { ...prev, ...p } : prev)),
				});
				const result = await createFileEntry(file.name, manifestDigest, fileKey);
				const message = errorMessage(result);
				if (message) {
					setUploadError(t("files.uploadEntryError", { name: file.name, message }));
					break;
				}
			} catch (err) {
				if (err.name === "AbortError") break;
				setUploadError(t("files.uploadFailedError", { name: file.name }));
				break;
			}
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
		setShareError("");
		try {
			const result = await shareFolder(ownerPubkey, privKeySig.value, dbKeySig.value, shareDialogTarget, [...shareSelectedPubkeys], publish, {
				serverUrl: BLOSSOM_URL,
				privateKey: privKeySig.value,
			});
			if (result instanceof Error) {
				setShareError(result.message || t("files.shareFailedGeneric"));
				return;
			}
			setShareDialogTarget(null);
		} catch {
			setShareError(t("files.networkUnavailable"));
		} finally {
			setShareBusy(false);
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
				serverUrl: BLOSSOM_URL,
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

	const entries = sortEntries(filterEntries(currentEntries.value, debouncedQuery), "name");
	const path = breadcrumbPath.value;
	const inTrash = currentFolderId.value === TRASH_ID;

	// Виртуализация (задача 3.2 TASK.md): "папка на 10⁴ элементов не
	// рендерится целиком". Рендерятся только entries[start:end] — окно
	// строк, видимое (+overscan) в единственной скролл-зоне экрана.
	const { anchorRef, start: windowStart, end: windowEnd } = useVirtualWindow({
		count: entries.length,
		rowHeight: ROW_HEIGHT_PX,
	});
	const visibleEntries = entries.slice(windowStart, windowEnd);

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

	function openEntry(entry) {
		if (entry.kind === "dir") {
			openFolder(entry.id);
			setSelected(new Set());
			return;
		}
		setPlayingDigest(entry.blob);
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
	// Игнорируем, если фокус в поле ввода (не перехватывать обычный текстовый
	// copy/paste пользователя внутри формы переименования/создания папки).
	useEffect(() => {
		function isTypingTarget(e) {
			const tag = e.target.tagName;
			return tag === "INPUT" || tag === "TEXTAREA";
		}
		function handleKeyDown(e) {
			if (isTypingTarget(e)) return;
			const mod = e.ctrlKey || e.metaKey;
			if (mod && e.key.toLowerCase() === "c") {
				e.preventDefault();
				copySelected();
			} else if (mod && e.key.toLowerCase() === "x") {
				e.preventDefault();
				cutSelected();
			} else if (mod && e.key.toLowerCase() === "v") {
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
		const node = containerRef.current;
		node?.addEventListener("keydown", handleKeyDown);
		return () => node?.removeEventListener("keydown", handleKeyDown);
	});

	if (!ready) return null;

	return (
		<>
		<Screen
			title={t("nav.files")}
			actions={
				<>
					<button type="button" class={view === "own" ? undefined : "btn--ghost"} onClick={() => setView("own")}>
						{t("files.myFilesTab")}
					</button>
					<button type="button" class={view === "mounts" ? undefined : "btn--ghost"} onClick={() => setView("mounts")}>
						<IconGlobe aria-hidden="true" /> {t("files.receivedFoldersTab")}{activeMounts.value.length > 0 ? ` (${activeMounts.value.length})` : ""}
					</button>
					{view === "own" && (
						<>
							<button type="button" onClick={() => setNewFolderOpen((v) => !v)}>
								<IconPlus /> {t("files.newFolderButton")}
							</button>
							<button type="button" class="btn--ghost" onClick={triggerFileUpload} disabled={!!uploadState}>
								<IconPaperclip aria-hidden="true" /> {t("files.uploadFileButton")}
							</button>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								onChange={handleFilesSelected}
								style={{ display: "none" }}
								aria-label={t("files.selectFilesAria")}
							/>
							{clipboard.value.state !== "empty" && (
								<button type="button" class="btn--ghost" onClick={pasteHere}>
									{t("files.pasteButton", { count: clipboard.value.selection.length })}
								</button>
							)}
							{canUndo.value && (
								<button type="button" class="btn--ghost" onClick={undo}>
									{t("common.undo")}
								</button>
							)}
						</>
					)}
				</>
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
			<div ref={containerRef} tabIndex={-1} class="files-shell">
				<div class="cluster file-breadcrumbs">
					<ol role="list" class="cluster file-breadcrumb-list">
						{path.map((crumb, i) => (
							<li key={crumb.id} class="cluster file-breadcrumb-item">
								{i > 0 && <IconChevronRight aria-hidden="true" />}
								{i === path.length - 1 ? (
									<span>{crumb.name}</span>
								) : (
									<button type="button" class="btn--ghost" onClick={() => openFolder(crumb.id)}>
										{crumb.name}
									</button>
								)}
							</li>
						))}
					</ol>
					<span class="grow" />
					{!inTrash && (
						<button type="button" class="btn--ghost" onClick={() => openFolder(TRASH_ID)}>
							<IconTrash /> {t("files.trashButton")}
						</button>
					)}
				</div>

				<div class="file-search-field">
					<IconMagnifyingGlass aria-hidden="true" />
					<label class="visually-hidden" for="file-search">
						{t("files.filterLabel")}
					</label>
					<input
						id="file-search"
						type="search"
						value={searchInput}
						onInput={(e) => setSearchInput(e.currentTarget.value)}
						placeholder={t("files.filterPlaceholder")}
					/>
				</div>

				{newFolderOpen && (
					<form class="cluster file-new-folder-form" onSubmit={handleCreateFolder}>
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
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{error}
					</p>
				)}
				{uploadState && (
					<div class="cluster file-upload-progress" role="status">
						<span>
							{t("files.uploadingProgress", {
								name: uploadState.fileName,
								index: uploadState.fileIndex,
								total: uploadState.filesTotal,
								percent: Math.round((uploadState.chunksDone / uploadState.chunksTotal) * 100),
							})}
						</span>
						<button type="button" class="btn--ghost" onClick={cancelUpload}>
							{t("common.undo")}
						</button>
					</div>
				)}
				{uploadError && (
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{uploadError}
					</p>
				)}

				{selected.size > 0 && (
					<div class="cluster file-selection-toolbar">
						<span>{t("files.selectionCount", { count: selected.size })}</span>
						<button type="button" class="btn--ghost" onClick={copySelected}>
							<IconCopy /> {t("common.copy")}
						</button>
						<button type="button" class="btn--ghost" onClick={cutSelected}>
							{t("files.cutButton")}
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
					<p style={{ color: "var(--muted)" }}>{inTrash ? t("files.trashEmpty") : t("files.folderEmpty")}</p>
				) : (
					<>
						<div ref={anchorRef} aria-hidden="true" />
						<ul
							role="list"
							class="file-row-list"
							style={{
								paddingBlockStart: `${windowStart * ROW_HEIGHT_PX}px`,
								paddingBlockEnd: `${(entries.length - windowEnd) * ROW_HEIGHT_PX}px`,
							}}
						>
						{visibleEntries.map((entry) => (
							<li
								key={entry.id}
								class={"file-row" + (dragOverId === entry.id ? " file-row--drag-over" : "")}
								draggable={!inTrash && renamingId !== entry.id}
								onDragStart={(e) => handleRowDragStart(entry, e)}
								onDragEnd={handleRowDragEnd}
								onDragOver={entry.kind === "dir" ? (e) => handleFolderDragOver(entry, e) : undefined}
								onDragLeave={entry.kind === "dir" ? () => handleFolderDragLeave(entry) : undefined}
								onDrop={entry.kind === "dir" ? (e) => handleFolderDrop(entry, e) : undefined}
							>
								<input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleSelect(entry.id)} aria-label={t("files.selectRowAria", { name: entry.displayName })} />
								{entry.kind === "dir" ? <IconFolder aria-hidden="true" class="file-row-icon" /> : <FileThumbnail entry={entry} ownerPubkey={ownerPubkey} />}
								{renamingId === entry.id ? (
									<form class="cluster file-rename-form" onSubmit={submitRename}>
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
									<button type="button" class="file-row-name" onDblClick={() => openEntry(entry)}>
										{entry.displayName}
									</button>
								)}
								{STATUS_LABEL_KEYS[entry.status] && <small class="file-row-status">{t(STATUS_LABEL_KEYS[entry.status])}</small>}
								{entry.kind === "dir" && sharedNodeIds.value.has(entry.id) && (
									<IconGlobe aria-hidden="true" title={t("files.sharedTooltip")} class="file-row-icon" />
								)}
								<span class="grow" />
								{inTrash ? (
									<>
										<button type="button" class="btn--ghost" onClick={() => handleRestore(entry.id)}>
											{t("files.restoreButton")}
										</button>
										<button type="button" class="btn--ghost btn--danger" onClick={() => handlePurge(entry.id)}>
											{t("files.purgeButton")}
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
											{t("files.cutButton")}
										</button>
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
										<button type="button" class="danger" onClick={() => handleDelete([entry.id])}>
											<IconTrash /> {t("common.delete")}
										</button>
									</ActionsMenu>
								)}
							</li>
						))}
						</ul>
					</>
				)}
			</div>
			)}
		</Screen>
		{playingDigest && <FilePlayer digest={playingDigest} ownerPubkey={ownerPubkey} onClose={() => setPlayingDigest(null)} />}
		{shareDialogTarget && (
			<ShareDialog
				busy={shareBusy}
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
function ShareDialog({ busy, error, selected, onToggle, onSubmit, onCancel }) {
	return (
		<ModalShell label={t("files.shareButton")} onClose={onCancel}>
			<h2>{t("files.shareButton")}</h2>
			<p style={{ color: "var(--muted)" }}>{t("files.shareDialogHint")}</p>
			{contacts.value.length === 0 ? (
				<p>{t("contacts.noContactsAtAll")}</p>
			) : (
				<ul role="list" class="stack">
					{contacts.value.map((pubkey) => (
						<li key={pubkey} class="cluster">
							<label class="cluster">
								<input type="checkbox" checked={selected.has(pubkey)} onChange={() => onToggle(pubkey)} />
								{profiles.value[pubkey]?.name || pubkey.slice(0, 16)}
							</label>
						</li>
					))}
				</ul>
			)}
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			<div class="cluster">
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
						<li key={pubkey} class="cluster">
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

// Раздел "Полученные доли" (этап 53 И6, задача 6.7 — сужение MVP, CONTRACTS.md):
// СВОЯ локальная навигация внутри ОДНОЙ доли, read-only (share() в v0.1 —
// только read-гранты), получение содержимого — ТОЛЬКО через "Сохранить себе".
function MountsView({ openMountId, mountFolderId, setMountFolderId, openMountView, closeMountView, handleSaveToOwn, handleUnmountShare, saveProgress }) {
	if (openMountId === null) {
		return (
			<div class="stack">
				{activeMounts.value.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>{t("files.noSharedWithYou")}</p>
				) : (
					<ul role="list" class="stack">
						{activeMounts.value.map((m) => (
							<li key={m.mountId} class="cluster file-row">
								<IconGlobe aria-hidden="true" class="file-row-icon" />
								<span class="grow">{profiles.value[m.ownerPubkey]?.name || `${m.ownerPubkey.slice(0, 16)}…`}</span>
								<button type="button" class="btn--ghost" onClick={() => openMountView(m.mountId)}>
									{t("files.openButton")}
								</button>
								<button type="button" class="btn--ghost btn--danger" onClick={() => handleUnmountShare(m.mountId)}>
									{t("files.disconnectButton")}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		);
	}

	const R = mountProjections.value.get(openMountId);
	if (!R) return null;
	// Mount.state — createInitialState() СОЗДАЁТ $trash/$lost+found (тот же
	// старт, что любой TreeState, mount.js) — это ТЕХНИЧЕСКИЕ узлы получателя
	// (пустые, никогда не наполняются владельцем доли — snapshotSubtree/
	// subtreeOpsRootedAt пишут только под ROOT_ID реального содержимого),
	// показывать их в списке доли бессмысленно и вводит в заблуждение
	// (найдено живым тестированием — пустая доля показывала "Корзину"/
	// "lost+found", будто это содержимое владельца).
	const entries = (R.children.get(mountFolderId) ?? [])
		.filter((id) => id !== TRASH_ID && id !== LOST_FOUND_ID)
		.map((id) => ({ id, ...R.nodes.get(id) }));

	return (
		<div class="stack">
			<div class="cluster">
				<button type="button" class="btn--ghost" onClick={closeMountView}>
					<IconChevronRight aria-hidden="true" style={{ transform: "rotate(180deg)" }} /> {t("files.backToMountsList")}
				</button>
				{mountFolderId !== ROOT_ID && (
					<button type="button" class="btn--ghost" onClick={() => setMountFolderId(ROOT_ID)}>
						{t("files.mountRootButton")}
					</button>
				)}
			</div>
			{saveProgress && (
				<p role="status">
					{t("files.savingProgress", { done: saveProgress.filesDone, total: saveProgress.filesTotal })}
				</p>
			)}
			{entries.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>{t("files.folderEmpty")}</p>
			) : (
				<ul role="list" class="file-row-list">
					{entries.map((entry) => (
						<li key={entry.id} class="file-row">
							{entry.kind === "dir" ? <IconFolder aria-hidden="true" class="file-row-icon" /> : <IconFileText aria-hidden="true" class="file-row-icon" />}
							{entry.kind === "dir" ? (
								<button type="button" class="file-row-name" onClick={() => setMountFolderId(entry.id)}>
									{entry.displayName}
								</button>
							) : (
								<span class="file-row-name">{entry.displayName}</span>
							)}
							<span class="grow" />
							<button type="button" class="btn--ghost" onClick={() => handleSaveToOwn(openMountId, entry.id)} disabled={!!saveProgress}>
								{t("files.saveToOwnButton")}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
