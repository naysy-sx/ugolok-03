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
import { currentUser } from "../signals/auth.js";
import {
	initFiles,
	currentFolderId,
	currentEntries,
	breadcrumbPath,
	clipboard,
	canUndo,
	createFolder,
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
} from "../signals/files.js";
import { ROOT_ID, TRASH_ID } from "../../domain/files/tree.js";
import { sortEntries } from "../../domain/files/sort.js";
import { filterEntries } from "../../domain/files/filter.js";
import { PreconditionError } from "../../domain/files/ops.js";
import { getManifest, getRange } from "../../domain/files/content.js";
import { getCachedManifest, putCachedManifest } from "../../domain/files/store.js";
import { isThumbnailable, createThumbnailBlob } from "../../domain/files/thumbnails.js";
import { createThumbnailQueue } from "../../domain/files/thumbnail-queue.js";
import { getMemoryCachedUrl, putMemoryCachedAttachment } from "../attachment-memory-cache.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import IconMagnifyingGlass from "../icons/magnifying-glass.jsx";
import { useVirtualWindow } from "../hooks/use-virtual-window.js";
import FilePlayer from "../components/file-player.jsx";

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
function FileThumbnail({ entry, ownerPubkey }) {
	const [url, setUrl] = useState(() => getMemoryCachedUrl(entry.blob) ?? null);
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
						setUrl(putMemoryCachedAttachment(entry.blob, thumbBytes, "image/jpeg"));
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
const STATUS_LABELS = {
	repaired: "перемещено в корень (конфликт синхронизации)",
	orphaned: "перемещено сюда (папка-родитель удалена)",
	renamed: "переименовано (совпадение имён после синхронизации)",
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

	useEffect(() => {
		initFiles(ownerPubkey).then(() => setReady(true));
	}, [ownerPubkey]);

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
		if (!window.confirm(ids.length > 1 ? `Переместить ${ids.length} объектов в корзину?` : "Переместить в корзину?")) return;
		for (const id of ids) await removeNode(id);
		setSelected(new Set());
	}

	async function handlePurge(id) {
		if (!window.confirm("Удалить безвозвратно? Это необратимо.")) return;
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
			title="Файлы"
			actions={
				<>
					<button type="button" onClick={() => setNewFolderOpen((v) => !v)}>
						<IconPlus /> Новая папка
					</button>
					{clipboard.value.state !== "empty" && (
						<button type="button" class="btn--ghost" onClick={pasteHere}>
							Вставить ({clipboard.value.selection.length})
						</button>
					)}
					{canUndo.value && (
						<button type="button" class="btn--ghost" onClick={undo}>
							Отменить
						</button>
					)}
				</>
			}
		>
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
							<IconTrash /> Корзина
						</button>
					)}
				</div>

				<div class="file-search-field">
					<IconMagnifyingGlass aria-hidden="true" />
					<label class="visually-hidden" for="file-search">
						Фильтр по имени в этой папке
					</label>
					<input
						id="file-search"
						type="search"
						value={searchInput}
						onInput={(e) => setSearchInput(e.currentTarget.value)}
						placeholder="Фильтр по имени…"
					/>
				</div>

				{newFolderOpen && (
					<form class="cluster file-new-folder-form" onSubmit={handleCreateFolder}>
						<label class="visually-hidden" for="new-folder-name">
							Имя папки
						</label>
						<input id="new-folder-name" type="text" value={newFolderName} onInput={(e) => setNewFolderName(e.currentTarget.value)} placeholder="Имя папки" autoFocus />
						<button type="submit">Создать</button>
						<button type="button" class="btn--ghost" onClick={() => setNewFolderOpen(false)}>
							Отмена
						</button>
					</form>
				)}
				{error && (
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{error}
					</p>
				)}

				{selected.size > 0 && (
					<div class="cluster file-selection-toolbar">
						<span>{selected.size} выбрано</span>
						<button type="button" class="btn--ghost" onClick={copySelected}>
							<IconCopy /> Копировать
						</button>
						<button type="button" class="btn--ghost" onClick={cutSelected}>
							Вырезать
						</button>
						<button type="button" class="btn--ghost btn--danger" onClick={() => handleDelete([...selected])}>
							<IconTrash /> Удалить
						</button>
						<button type="button" class="btn--ghost" onClick={() => setSelected(new Set())}>
							Снять выделение
						</button>
					</div>
				)}

				{entries.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>{inTrash ? "Корзина пуста." : "Здесь пока ничего нет."}</p>
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
							<li key={entry.id} class="file-row">
								<input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleSelect(entry.id)} aria-label={`Выбрать «${entry.displayName}»`} />
								{entry.kind === "dir" ? <IconFolder aria-hidden="true" class="file-row-icon" /> : <FileThumbnail entry={entry} ownerPubkey={ownerPubkey} />}
								{renamingId === entry.id ? (
									<form class="cluster file-rename-form" onSubmit={submitRename}>
										<label class="visually-hidden" for={`rename-${entry.id}`}>
											Новое имя
										</label>
										<input id={`rename-${entry.id}`} type="text" value={renameValue} onInput={(e) => setRenameValue(e.currentTarget.value)} autoFocus />
										<button type="submit" class="icon-btn" aria-label="Сохранить">
											<IconCheck />
										</button>
										<button type="button" class="icon-btn" onClick={() => setRenamingId(null)} aria-label="Отменить переименование">
											<IconCross />
										</button>
									</form>
								) : (
									<button type="button" class="file-row-name" onDblClick={() => openEntry(entry)}>
										{entry.displayName}
									</button>
								)}
								{STATUS_LABELS[entry.status] && <small class="file-row-status">{STATUS_LABELS[entry.status]}</small>}
								<span class="grow" />
								{inTrash ? (
									<>
										<button type="button" class="btn--ghost" onClick={() => handleRestore(entry.id)}>
											Восстановить
										</button>
										<button type="button" class="btn--ghost btn--danger" onClick={() => handlePurge(entry.id)}>
											Удалить навсегда
										</button>
									</>
								) : (
									<ActionsMenu label={`Действия с «${entry.displayName}»`}>
										<button type="button" onClick={() => startRename(entry)}>
											<IconPencil /> Переименовать
										</button>
										<button type="button" onClick={() => copySelection([entry.id])}>
											<IconCopy /> Копировать
										</button>
										<button type="button" onClick={() => cutSelection([entry.id])}>
											Вырезать
										</button>
										<button type="button" class="danger" onClick={() => handleDelete([entry.id])}>
											<IconTrash /> Удалить
										</button>
									</ActionsMenu>
								)}
							</li>
						))}
						</ul>
					</>
				)}
			</div>
		</Screen>
		{playingDigest && <FilePlayer digest={playingDigest} ownerPubkey={ownerPubkey} onClose={() => setPlayingDigest(null)} />}
		</>
	);
}
