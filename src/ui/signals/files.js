// Мост между чистым domain/files и UI (CONTRACTS.md, этап 53) — тот же
// простой паттерн, что ui/signals/journal.js: сигнал пересчитывается из
// текущего состояния, действия пользователя вызывают domain-функции, потом
// пересохраняют и обновляют сигнал. Здесь чуть сложнее (собственный
// Lamport-счётчик, undo-стек) — но принцип тот же.
import { signal, computed } from "@preact/signals";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createInitialState, merge, project, ROOT_ID, TRASH_ID } from "../../domain/files/tree.js";
import { createFolder as opCreateFolder, createFile as opCreateFile, rename as opRename, move as opMove, copy as opCopy, remove as opRemove, purge as opPurge, PreconditionError } from "../../domain/files/ops.js";
import { saveTreeState, loadTreeState, loadFilesClockValue, saveFilesClockValue, saveFileKey, getFileKey, listUnannouncedFileKeys, markFileKeyAnnounced } from "../../domain/files/store.js";
import { buildFilesLogEvent, parseFilesLogEvent, KIND_FILES_OP } from "../../domain/files/sync.js";
import { db } from "../../core/store/database.js";
import { dbKeySig } from "./auth.js";
import { createClipboard, copyToClipboard, cutToClipboard, paste as pasteClipboard, cancelClipboard } from "../../domain/files/clipboard.js";
import { createUndoStack, pushUndo, popUndo, canUndo as canUndoNow, recordMove, recordRename, recordCreate } from "../../domain/files/undo.js";
import { createLamportClock } from "../../core/sync/lamport.js";
import { getOrCreateDeviceId } from "../../domain/identity/device.js";

// Дребезг публикации (CONTRACTS.md, этап 53 И5, задача 5.2) — середина
// диапазона 200-500мс TASK.md §6. Серия быстрых правок ОДНОГО узла (или
// нескольких подряд) даёт ОДНО сетевое событие, не одно на правку.
const PUBLISH_DEBOUNCE_MS = 300;

export const treeState = signal(createInitialState());
export const currentFolderId = signal(ROOT_ID);
export const clipboard = signal(createClipboard());
export const selectedIds = signal(new Set());
export const canUndo = signal(false);

export const projected = computed(() => project(treeState.value));

// currentEntries — живые (не purged) дети текущей папки, разыменованные из
// projected.nodes. Компонент сам сортирует (sort.js) — здесь только состав.
export const currentEntries = computed(() => {
	const R = projected.value;
	const ids = R.children.get(currentFolderId.value) ?? [];
	return ids.map((id) => ({ id, ...R.nodes.get(id) }));
});

export const breadcrumbPath = computed(() => {
	const R = projected.value;
	const path = [];
	let cur = currentFolderId.value;
	let steps = 0;
	while (cur !== null && steps < 128) {
		const node = R.nodes.get(cur);
		if (!node) break;
		path.unshift({ id: cur, name: cur === ROOT_ID ? "Файлы" : node.displayName });
		cur = node.parent;
		steps += 1;
	}
	return path;
});

let undoStack = createUndoStack();
let lamportClock = null;
let cachedDeviceId = null;
let cachedOwnerPubkey = null;
let cachedPrivKey = null;
let cachedPublish = null;
let pendingOps = [];
let publishTimer = null;

// publish НЕ импортируется из signals/transport.js напрямую (иначе модуль
// не тестируется без реальной сети) — передаётся явно через initFiles, по
// прецеденту configureContactRuntime({ownerPubkey, privKey, dbKey, publish})
// (ui/signals/contacts.js). Ошибка публикации — best-effort (тот же
// принцип, что saveUiSettings): локальное состояние уже применено и
// сохранено ДО постановки в очередь, сбой сети не откатывает его.
function queueForPublish(ops) {
	if (!cachedPublish || ops.length === 0) return;
	pendingOps.push(...ops);
	clearTimeout(publishTimer);
	publishTimer = setTimeout(flushPendingOps, PUBLISH_DEBOUNCE_MS);
}

function flushPendingOps() {
	publishTimer = null;
	if (pendingOps.length === 0) return;
	const ops = pendingOps;
	pendingOps = [];
	const event = buildFilesLogEvent(cachedPrivKey, ops);
	cachedPublish(event).catch(() => {});
}

// Экспортирована (этап 53 И6, задача 6.7) — ui/signals/mounts.js нужна ТА
// ЖЕ метка Лампорта дерева файлов для mount()'s createFolder (узел-ссылка —
// ОБЫЧНАЯ локальная операция над ЭТИМ ЖЕ деревом, CONTRACTS.md 6.3). Два
// НЕЗАВИСИМЫХ счётчика для одного дерева расходились бы — единый источник
// (эта функция) устраняет класс гонки целиком: JS однопоточен, lamportClock.tick()
// синхронен, поэтому ЛЮБЫЕ два "параллельных" вызова label() (из UI-события
// И из фонового подписчика гранта) гарантированно сериализуются на разные
// counter. ownerPubkeyForInit — самоинициализация: входящий грант (mounts.js)
// может прийти РАНЬШЕ, чем пользователь хоть раз откроет "Файлы" в сессии
// (initFiles() тогда ещё не вызывалась) — без него label() бросала бы
// "initFiles() ещё не вызван" для полностью легитимного фонового случая.
export async function label(ownerPubkeyForInit) {
	const ownerPubkey = cachedOwnerPubkey ?? ownerPubkeyForInit;
	if (!ownerPubkey) throw new Error("files: initFiles() ещё не вызван и ownerPubkeyForInit не передан");
	if (!lamportClock) {
		cachedDeviceId = cachedDeviceId ?? (await getOrCreateDeviceId());
		const initialCounter = await loadFilesClockValue(ownerPubkey);
		lamportClock = createLamportClock(initialCounter);
	}
	const counter = lamportClock.tick();
	await saveFilesClockValue(ownerPubkey, counter);
	return { counter, deviceId: cachedDeviceId };
}

// privKey/publish — новые параметры (CONTRACTS.md, этап 53 И5, задача
// 5.2/5.3): нужны для дребезг-публикации локальных операций и для фолда
// уже осевшего в db.events сетевого журнала при первом открытии экрана в
// сессии. Вызывающая сторона (files.jsx) передаёт privKeySig.value и
// publish из transport.js.
export async function initFiles(ownerPubkey, privKey, publish) {
	cachedOwnerPubkey = ownerPubkey;
	cachedPrivKey = privKey;
	cachedPublish = publish;
	cachedDeviceId = await getOrCreateDeviceId();
	const initialCounter = await loadFilesClockValue(ownerPubkey);
	lamportClock = createLamportClock(initialCounter);

	const loaded = await loadTreeState(ownerPubkey);
	if (loaded.nodes.has(ROOT_ID)) {
		treeState.value = loaded;
	} else {
		// Первое обращение этого владельца к разделу "Файлы" — loadTreeState
		// на пустой БД возвращает пустую карту (store.js хранит РОВНО то, что
		// сохранено, системные узлы не подразумевает сам). createInitialState()
		// даёт их — сразу же персистируем, иначе следующий initFiles() снова
		// попадёт сюда же.
		treeState.value = createInitialState();
		await saveTreeState(ownerPubkey, treeState.value);
	}
	currentFolderId.value = ROOT_ID;
	undoStack = createUndoStack();
	canUndo.value = false;

	// Подтягиваем весь ранее накопленный сетевой журнал СРАЗУ при открытии
	// экрана (не ждём живого onEvent) — если privKey ещё недоступен (не
	// должно случаться в норме, но initFiles не обязан на это полагаться),
	// пропускаем без падения.
	if (privKey) {
		await rebuildFilesLog(ownerPubkey, privKey);
		// Этап 57 — довыдача fileKey файлам, созданным ДО этого фикса (см.
		// backfillOwnFileKeys выше). publish может быть undefined (та же
		// ситуация, что дребезг публикации без сети) — best-effort, не блокирует.
		if (publish) await backfillOwnFileKeys(ownerPubkey, privKey, publish);
	}
}

// Экспортирована (этап 53 И6, задача 6.7) — тот же случай, что label() выше:
// mounts.js применяет свои create/purge-опы (mount()/unmount()/saveToOwn) К
// ЭТОМУ ЖЕ дереву файлов, переиспользуя ВСЮ существующую персистентность/
// публикацию, а не дублируя её. ownerPubkeyForInit — тот же принцип
// самоинициализации, что у label().
export async function applyAndPersist(ops, ownerPubkeyForInit) {
	const ownerPubkey = cachedOwnerPubkey ?? ownerPubkeyForInit;
	if (!ownerPubkey) throw new Error("files: initFiles() ещё не вызван и ownerPubkeyForInit не передан");
	treeState.value = merge(treeState.value, ops);
	await saveTreeState(ownerPubkey, treeState.value);
	queueForPublish(ops);
}

// Фолд сетевого журнала (CONTRACTS.md/DESIGN.md, этап 53 И5, задача 5.3).
// Ленивая активация — осознанное отличие от rebuildUiSettings/rebuildGroups
// (те вызываются из ГЛОБАЛЬНОГО bootstrap независимо от экрана): дерево
// файлов не отображается нигде, кроме самого экрана "Файлы", поэтому
// no-op, если initFiles ещё не вызывался ДЛЯ ЭТОГО owner в этой сессии —
// не тратим цикл на 100% no-op для тех, кто ни разу не открывал "Файлы".
export async function rebuildFilesLog(ownerPubkey, privKey) {
	if (cachedOwnerPubkey !== ownerPubkey) return;

	const rows = await db.table("events").where("[pubkey+kind]").equals([ownerPubkey, KIND_FILES_OP]).toArray();
	const allOps = [];
	let maxCounter = 0;
	for (const row of rows) {
		try {
			const ops = parseFilesLogEvent(row, privKey);
			for (const op of ops) {
				allOps.push(op);
				if (op.label && op.label.counter > maxCounter) maxCounter = op.label.counter;
			}
		} catch {
			// Повреждённое/нерасшифровываемое событие — пропустить, не ронять
			// фолд остальных валидных (тот же приём, что getChunk/getRange И4:
			// одна испорченная единица не портит весь результат).
		}
	}
	if (allOps.length === 0) return;

	// Этап 57 — create-операция может нести fileKey (журнал уже NIP-44-
	// шифруется владельцем самому себе, провезти секрет внутри безопасно) —
	// без этого шага файл виден в дереве, но НИКОГДА не расшифруется на этом
	// устройстве (найдено живой проверкой). Уже известный локально ключ не
	// перезаписывается — эта ветка только ДОБАВЛЯЕТ то, чего не хватало.
	for (const op of allOps) {
		if (op.type === "create" && op.kind === "file" && op.fileKey) {
			const existing = await getFileKey(ownerPubkey, dbKeySig.value, op.blob);
			if (existing === undefined) {
				await saveFileKey(ownerPubkey, dbKeySig.value, op.blob, hexToBytes(op.fileKey), true);
			}
		}
	}

	// ОДИН merge на ВСЮ пачку, ОДИН saveTreeState — I-BATCH (тот же инвариант,
	// что 2.7/3.9), не по одному пересчёту на событие.
	treeState.value = merge(treeState.value, allOps);
	await saveTreeState(ownerPubkey, treeState.value);

	if (lamportClock) {
		lamportClock.receive(maxCounter);
		await saveFilesClockValue(ownerPubkey, lamportClock.getValue());
	}
}

// Этап 57 — задним числом довыдаёт fileKey файлам, чей create-Op был
// опубликован ДО этого фикса (без fileKey) — иначе другие устройства того же
// владельца никогда не расшифруют файл, даже с уже видимой структурой дерева.
// republish ТОГО ЖЕ create-Op (тот же id) — applyOp уже идемпотентен на
// повторный create с существующим id ("идемпотентный повтор", tree.js),
// поэтому строим объект операции напрямую (не через createFile из ops.js —
// тот отклонит с PreconditionError NAME_TAKEN, имя уже занято этим же узлом),
// тот же приём, что save-to-own.js. Вызывается из initFiles сразу после
// rebuildFilesLog — та же ленивая активация, что весь раздел "Файлы".
export async function backfillOwnFileKeys(ownerPubkey, privKey, publish) {
	const unannounced = await listUnannouncedFileKeys(ownerPubkey, dbKeySig.value);
	let count = 0;
	for (const { digest, fileKey } of unannounced) {
		const node = Array.from(treeState.value.nodes.values()).find((n) => n.kind === "file" && n.blob === digest);
		if (!node) continue; // файл не найден локально — пропустить, не бросать
		const op = {
			type: "create",
			id: node.id,
			kind: "file",
			blob: digest,
			parentId: node.par.value,
			name: node.name.value,
			origin: node.origin.value,
			label: await label(),
			fileKey: bytesToHex(fileKey),
		};
		try {
			const event = buildFilesLogEvent(privKey, [op]);
			const result = await publish(event);
			if (result.ok) {
				await markFileKeyAnnounced(ownerPubkey, digest);
				count++;
			}
			// иначе — best-effort, попробуем на следующем connect(), не бросаем
		} catch {
			// сбой для этого файла (relay недоступен и т.п.) — не ронять обработку остальных
		}
	}
	return count;
}

function randomNodeId() {
	return crypto.getRandomValues(new Uint8Array(16)).reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "n-");
}

export async function createFolder(name) {
	const op = opCreateFolder(treeState.value, currentFolderId.value, name, randomNodeId(), await label());
	if (op instanceof PreconditionError) return op;
	await applyAndPersist([op]);
	pushUndo(undoStack, [recordCreate(op.id)]);
	canUndo.value = canUndoNow(undoStack);
	return op;
}

// Узел-файл поверх уже загруженного содержимого (content.putStream, И2) —
// сама загрузка (выбор файла с диска, прогресс) — задача И7, здесь только
// связывание готового manifestDigest с деревом. fileKey сохраняется СРАЗУ
// (store.js's saveFileKey, зашифрован dbKey) — без этого файл стал бы
// нерасшифровываем после первой же перезагрузки (найдено при реализации
// миниатюр, задача 3.8 — ключ раньше нигде не персистировался).
export async function createFileEntry(name, blobDigest, fileKey, origin = null) {
	// Этап 57 — fileKey едет прямо в create-Op (журнал уже NIP-44-самошифрован,
	// провезти секрет внутри безопасно) — announced=true сразу, backfillOwnFileKeys
	// нечего будет довыдавать для файлов, созданных с этого момента.
	const op = opCreateFile(treeState.value, currentFolderId.value, name, randomNodeId(), blobDigest, await label(), origin, bytesToHex(fileKey));
	if (op instanceof PreconditionError) return op;
	await saveFileKey(cachedOwnerPubkey, dbKeySig.value, blobDigest, fileKey, true);
	await applyAndPersist([op]);
	pushUndo(undoStack, [recordCreate(op.id)]);
	canUndo.value = canUndoNow(undoStack);
	return op;
}

// Для чтения (миниатюры, будущий плеер И4) — по digest, не по узлу
// (несколько узлов, включая копии, могут ссылаться на один и тот же blob).
export async function getFileKeyFor(digest) {
	return getFileKey(cachedOwnerPubkey, dbKeySig.value, digest);
}

export async function renameNode(id, name) {
	const previousName = treeState.value.nodes.get(id).name.value;
	const op = opRename(treeState.value, id, name, await label());
	if (op instanceof PreconditionError) return op;
	await applyAndPersist([op]);
	pushUndo(undoStack, [recordRename(id, previousName)]);
	canUndo.value = canUndoNow(undoStack);
	return op;
}

export async function moveNode(id, newParentId) {
	const previousParentId = treeState.value.nodes.get(id).par.value;
	const op = opMove(treeState.value, id, newParentId, await label());
	if (op instanceof PreconditionError) return op;
	await applyAndPersist([op]);
	pushUndo(undoStack, [recordMove(id, previousParentId)]);
	canUndo.value = canUndoNow(undoStack);
	return op;
}

export async function removeNode(id) {
	const previousParentId = treeState.value.nodes.get(id).par.value;
	const op = opRemove(treeState.value, id, await label());
	await applyAndPersist([op]);
	pushUndo(undoStack, [recordMove(id, previousParentId)]); // "удалить" = move, отмена — обратный move (§5.6 MATH.md)
	canUndo.value = canUndoNow(undoStack);
}

export async function purgeNode(id) {
	const op = opPurge(treeState.value, id);
	await applyAndPersist([op]); // НЕ кладём в undo-стек — purge монотонен, необратим (§5.6 MATH.md)
}

export async function copySelectionHere(nodeIds) {
	const ops = [];
	const createdRootIds = [];
	for (const nodeId of nodeIds) {
		const newIds = collectNewIds(treeState.value, nodeId);
		const subtreeOps = opCopy(treeState.value, nodeId, currentFolderId.value, newIds, await label());
		ops.push(...subtreeOps);
		createdRootIds.push(newIds.get(nodeId));
	}
	await applyAndPersist(ops);
	pushUndo(undoStack, createdRootIds.map((id) => recordCreate(id)));
	canUndo.value = canUndoNow(undoStack);
}

// Экспортирована (этап 53 И6, задача 6.7) — mounts.js's saveMountedItemToOwn
// нужен тот же приём генерации новых id для целого поддерева, что copySelectionHere.
export function collectNewIds(S, rootId) {
	const map = new Map();
	const stack = [rootId];
	while (stack.length > 0) {
		const cur = stack.pop();
		map.set(cur, randomNodeId());
		for (const [id, node] of S.nodes) {
			if (!node.purged && node.par.value === cur) stack.push(id);
		}
	}
	return map;
}

export function copySelection(nodeIds) {
	clipboard.value = copyToClipboard(clipboard.value, [...nodeIds]);
}
export function cutSelection(nodeIds) {
	clipboard.value = cutToClipboard(clipboard.value, [...nodeIds]);
}
export function cancelSelection() {
	clipboard.value = cancelClipboard(clipboard.value);
}

// Инвариант §4.1 MATH.md: узел из Cut(S), удалённый другой репликой до
// paste — no-op для него, не ошибка (остальные из выделения обрабатываются
// нормально). Проверяем существование (живой узел в ТЕКУЩЕМ дереве) здесь,
// перед конструированием операций.
export async function pasteHere() {
	const c = clipboard.value;
	const liveIds = c.selection.filter((id) => treeState.value.nodes.get(id) && !treeState.value.nodes.get(id).purged);
	if (c.state === "cut") {
		for (const id of liveIds) {
			await moveNode(id, currentFolderId.value);
		}
	} else if (c.state === "copied") {
		await copySelectionHere(liveIds);
	}
	clipboard.value = pasteClipboard(c);
	selectedIds.value = new Set();
}

export async function undo() {
	if (!canUndoNow(undoStack)) return;
	const ops = popUndo(undoStack, () => {
		const counter = lamportClock.tick();
		saveFilesClockValue(cachedOwnerPubkey, counter);
		return { counter, deviceId: cachedDeviceId };
	});
	await applyAndPersist(ops);
	canUndo.value = canUndoNow(undoStack);
}

export function openFolder(id) {
	currentFolderId.value = id;
	selectedIds.value = new Set();
}
