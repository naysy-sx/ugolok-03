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
} from "../signals/files.js";
import { ROOT_ID, TRASH_ID } from "../../domain/files/tree.js";
import { sortEntries } from "../../domain/files/sort.js";
import { PreconditionError } from "../../domain/files/ops.js";

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

// Пока БЕЗ виртуализации (задача 3.2), фильтра (3.7) и миниатюр (3.8) —
// первая функциональная волна: навигация, CRUD, буфер обмена, корзина,
// отмена. Файлы (в отличие от папок) показывают общую иконку — размер/mime
// живут в манифесте (content.js), не в самом узле дерева; подгрузка
// манифеста по каждой строке — из той же серии, что миниатюры, следующим
// шагом (3.8), не задача этого прохода.
export default function Files() {
	const ownerPubkey = currentUser.value.id;
	const [ready, setReady] = useState(false);
	const [selected, setSelected] = useState(() => new Set());
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const [renamingId, setRenamingId] = useState(null);
	const [renameValue, setRenameValue] = useState("");
	const [error, setError] = useState("");
	const containerRef = useRef(null);

	useEffect(() => {
		initFiles(ownerPubkey).then(() => setReady(true));
	}, [ownerPubkey]);

	const entries = sortEntries(currentEntries.value, "name");
	const path = breadcrumbPath.value;
	const inTrash = currentFolderId.value === TRASH_ID;

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
		}
		// Файлы: просмотр/плеер — задача И4, здесь пока не открываются кликом.
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
					<ul role="list" class="file-row-list">
						{entries.map((entry) => (
							<li key={entry.id} class="file-row">
								<input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleSelect(entry.id)} aria-label={`Выбрать «${entry.displayName}»`} />
								{entry.kind === "dir" ? <IconFolder aria-hidden="true" class="file-row-icon" /> : <IconFileText aria-hidden="true" class="file-row-icon" />}
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
				)}
			</div>
		</Screen>
	);
}
