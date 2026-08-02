import { useState, useEffect } from "preact/hooks";
import { initFiles, projected } from "../signals/files.js";
import { currentUser, privKeySig } from "../signals/auth.js";
import { publish } from "../signals/transport.js";
import { ROOT_ID, TRASH_ID } from "../../domain/files/tree.js";
import { sortEntries } from "../../domain/files/sort.js";
import IconFolder from "../icons/folder.jsx";
import IconFileText from "../icons/file-text.jsx";
import IconChevronRight from "../icons/chevron-right.jsx";
import { t } from "../signals/i18n.js";

// FilePicker (§5.7 TASK.md) — ЕДИНАЯ реализация выбора узла из хранилища,
// два потребителя (аватар — И7 7.2, вложение в чат — И7 7.3). "Второй
// реализации быть не должно" (TASK.md буквально) — оба места ниже по стеку
// переиспользуют этот компонент, не пишут свою навигацию по дереву.
//
// Собственный курсор навигации (folderId, локальный useState), НЕ общий
// currentFolderId из files.js — иначе открытие пикера поверх другого экрана
// молча переставляло бы текущую папку экрана "Файлы" (тот же treeState/
// projected, но independent курсор просмотра). initFiles() вызывается здесь
// же (идемпотентный бутстрап, тот же приём, что files.jsx) — пикер может
// быть открыт БЕЗ того, чтобы пользователь хоть раз заходил в "Файлы".
//
// predicate(node) — синхронна, судит по полям Node (§4.1 TASK.md: kind/
// blob/origin/displayName), БЕЗ mime — манифест недоступен без сетевого
// запроса на каждую строку списка. Ограничение по mime (аватар — только
// image/*) — постфактум, после onSelect, тем же приёмом, что уже был у
// прежнего <input type="file"> (сообщение об ошибке, не скрытие строки).
// Папки ВСЕГДА навигируемы независимо от predicate — тот применяется
// только к файлам.
export default function FilePicker({ predicate = () => true, multiple = false, onSelect, onCancel }) {
	const ownerPubkey = currentUser.value.id;
	const [ready, setReady] = useState(false);
	const [folderId, setFolderId] = useState(ROOT_ID);
	const [selected, setSelected] = useState(() => new Set());

	useEffect(() => {
		initFiles(ownerPubkey, privKeySig.value, publish).then(() => setReady(true));
	}, [ownerPubkey]);

	useEffect(() => {
		function handleKeyDown(e) {
			if (e.key === "Escape") onCancel();
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onCancel]);

	function toggle(id) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function openEntry(entry) {
		if (entry.kind === "dir") {
			setFolderId(entry.id);
			return;
		}
		if (!predicate(entry)) return;
		if (multiple) {
			toggle(entry.id);
			return;
		}
		onSelect([entry.id]);
	}

	function confirmSelection() {
		if (selected.size === 0) return;
		onSelect([...selected]);
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={t("filePicker.dialogAria")}
			onClick={onCancel}
			style={{ position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "var(--space-m)" }}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				class="stack"
				style={{ background: "var(--surface, canvas)", borderRadius: "var(--radius)", padding: "var(--space-m)", maxWidth: "36rem", width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column" }}
			>
				<h2>{t("profile.chooseFromStorageButton")}</h2>
				{!ready ? (
					<p>{t("common.loading")}</p>
				) : (
					<PickerBody folderId={folderId} setFolderId={setFolderId} predicate={predicate} selected={selected} multiple={multiple} onOpenEntry={openEntry} />
				)}
				<div class="cluster" style={{ justifyContent: "flex-end" }}>
					{multiple && (
						<button type="button" onClick={confirmSelection} disabled={selected.size === 0}>
							{t("filePicker.selectButton")} {selected.size > 0 ? `(${selected.size})` : ""}
						</button>
					)}
					<button type="button" class="btn--ghost" onClick={onCancel}>
						{t("common.cancel")}
					</button>
				</div>
			</div>
		</div>
	);
}

function PickerBody({ folderId, setFolderId, predicate, selected, multiple, onOpenEntry }) {
	const R = projected.value;

	const path = [];
	{
		let cur = folderId;
		let steps = 0;
		while (cur !== null && cur !== undefined && steps < 128) {
			const node = R.nodes.get(cur);
			if (!node) break;
			path.unshift({ id: cur, name: cur === ROOT_ID ? t("nav.files") : node.displayName });
			cur = node.parent;
			steps += 1;
		}
	}

	// Корзина скрыта — выбирать удалённый файл не имеет смысла (то же
	// решение, что MountsView скрывает TRASH_ID/LOST_FOUND_ID для чужих
	// долей, здесь же lost+found остаётся: это живое, не удалённое
	// содержимое, просто осиротевшее).
	const ids = (R.children.get(folderId) ?? []).filter((id) => id !== TRASH_ID);
	const entries = sortEntries(ids.map((id) => ({ id, ...R.nodes.get(id) })));

	return (
		<>
			<nav class="cluster" aria-label={t("filePicker.breadcrumbAria")} style={{ flexWrap: "wrap" }}>
				{path.map((crumb, i) => (
					<span key={crumb.id} class="cluster" style={{ gap: "var(--space-2xs)" }}>
						{i > 0 && <IconChevronRight aria-hidden="true" />}
						<button type="button" class="btn--ghost" onClick={() => setFolderId(crumb.id)}>
							{crumb.name}
						</button>
					</span>
				))}
			</nav>
			<ul role="list" class="file-row-list" style={{ overflowY: "auto", flex: 1 }}>
				{entries.length === 0 && <p style={{ color: "var(--muted)" }}>{t("files.folderEmpty")}</p>}
				{entries.map((entry) => {
					const selectable = entry.kind === "dir" || predicate(entry);
					return (
						<li key={entry.id} class="file-row">
							{multiple && entry.kind === "file" && (
								<input
									type="checkbox"
									checked={selected.has(entry.id)}
									disabled={!selectable}
									onChange={() => onOpenEntry(entry)}
									aria-label={t("files.selectRowAria", { name: entry.displayName })}
								/>
							)}
							{entry.kind === "dir" ? <IconFolder aria-hidden="true" class="file-row-icon" /> : <IconFileText aria-hidden="true" class="file-row-icon" />}
							<button type="button" class="file-row-name" disabled={!selectable} onClick={() => onOpenEntry(entry)} style={!selectable ? { opacity: 0.5 } : undefined}>
								{entry.displayName}
							</button>
						</li>
					);
				})}
			</ul>
		</>
	);
}
