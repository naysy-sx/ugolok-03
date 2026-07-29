import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { ROOT_ID, TRASH_ID } from "../src/domain/files/tree.js";
import { dbKeySig } from "../src/ui/signals/auth.js";
import {
	initFiles,
	treeState,
	currentFolderId,
	currentEntries,
	breadcrumbPath,
	clipboard,
	canUndo,
	createFolder,
	createFileEntry,
	getFileKeyFor,
	renameNode,
	moveNode,
	removeNode,
	purgeNode,
	copySelection,
	cutSelection,
	pasteHere,
	undo,
	openFolder,
} from "../src/ui/signals/files.js";

const OWNER = "owner-signals-test";

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("files_nodes").clear();
	await db.table("clock").clear();
	await db.table("files_keys").clear();
	dbKeySig.value = crypto.getRandomValues(new Uint8Array(32));
	await initFiles(OWNER);
});

after(() => {
	db.close();
});

test("initFiles: пустое хранилище -> корень содержит только системные Корзину/lost+found", async () => {
	assert.equal(currentFolderId.value, ROOT_ID);
	const names = currentEntries.value.map((e) => e.displayName).sort();
	assert.deepEqual(names, ["lost+found", "Корзина"]);
	assert.deepEqual(
		breadcrumbPath.value.map((p) => p.name),
		["Файлы"],
	);
});

test("createFolder: появляется в currentEntries, персистентна между initFiles", async () => {
	const op = await createFolder("Документы");
	assert.ok(op.id);
	// Внутри самой созданной папки (не в корне — там ещё Корзина/lost+found).
	openFolder(op.id);
	const parent = await createFolder("Вложенная"); // тест на возможность создать НУТРИ
	assert.ok(!(parent instanceof Error));
	assert.equal(currentEntries.value.length, 1);
	assert.equal(currentEntries.value[0].displayName, "Вложенная");

	await initFiles(OWNER); // 'перезагрузка'
	openFolder(op.id);
	assert.equal(currentEntries.value.length, 1, "пережило перезагрузку хранилища");
});

test("createFolder: PreconditionError при занятом имени, не роняет приложение", async () => {
	const parent = await createFolder("Родитель");
	openFolder(parent.id);
	await createFolder("Дубль");
	const result = await createFolder("Дубль");
	assert.equal(result.name, "PreconditionError");
	assert.equal(currentEntries.value.length, 1, "второй вызов не создал узел");
});

test("createFileEntry: создаёт узел kind='file' с указанным digest, появляется в currentEntries, сохраняет ключ", async () => {
	const fileKey = crypto.getRandomValues(new Uint8Array(32));
	const op = await createFileEntry("фото.jpg", "digest-xyz", fileKey);
	assert.ok(op.id);
	const entry = currentEntries.value.find((e) => e.id === op.id);
	assert.ok(entry);
	assert.equal(entry.kind, "file");
	assert.equal(entry.blob, "digest-xyz");

	const gotKey = await getFileKeyFor("digest-xyz");
	assert.deepEqual(gotKey, fileKey);
});

test("openFolder/breadcrumbPath: навигация внутрь и хлебные крошки отражают путь", async () => {
	const op = await createFolder("A");
	openFolder(op.id);
	assert.equal(currentFolderId.value, op.id);
	assert.deepEqual(
		breadcrumbPath.value.map((p) => p.name),
		["Файлы", "A"],
	);
});

test("renameNode/moveNode: применяются и переживают перезагрузку", async () => {
	const container = await createFolder("Контейнер");
	openFolder(container.id);
	const a = await createFolder("A");
	const b = await createFolder("B");
	await renameNode(a.id, "A-переименовано");
	await moveNode(a.id, b.id);

	await initFiles(OWNER);
	openFolder(b.id);
	assert.equal(currentEntries.value.length, 1);
	assert.equal(currentEntries.value[0].displayName, "A-переименовано");
});

test("removeNode: узел уходит в корзину, restoreNode(=moveNode обратно) восстанавливает", async () => {
	const container = await createFolder("Контейнер");
	openFolder(container.id);
	const a = await createFolder("A");
	await removeNode(a.id);
	assert.equal(currentEntries.value.length, 0, "пропал из текущей папки");
	assert.equal(treeState.value.nodes.get(a.id).par.value, TRASH_ID);

	await moveNode(a.id, container.id); // "восстановить" — это тоже move, §5.6 MATH.md
	assert.equal(currentEntries.value.length, 1);
});

test("purgeNode: НЕ попадает в undo-стек (canUndo остаётся как было до purge)", async () => {
	const a = await createFolder("A");
	await removeNode(a.id);
	const canUndoBeforePurge = canUndo.value;
	await purgeNode(a.id);
	assert.equal(canUndo.value, canUndoBeforePurge, "purge не добавил новую запись в undo-стек");
});

test("undo: отменяет последнее действие (rename)", async () => {
	const a = await createFolder("A");
	await renameNode(a.id, "Новое имя");
	assert.equal(canUndo.value, true);
	await undo();
	assert.equal(treeState.value.nodes.get(a.id).name.value, "A");
});

test("copySelection/pasteHere: копия появляется в целевой папке, оригинал остаётся", async () => {
	const container = await createFolder("Контейнер");
	openFolder(container.id);
	const a = await createFolder("A");
	const b = await createFolder("B");
	copySelection([a.id]);
	assert.equal(clipboard.value.state, "copied");
	openFolder(b.id);
	await pasteHere();

	assert.equal(currentEntries.value.length, 1);
	assert.notEqual(currentEntries.value[0].id, a.id, "копия — НОВЫЙ узел, не тот же id");
	assert.equal(clipboard.value.state, "empty", "буфер сброшен после вставки");

	openFolder(container.id);
	assert.ok(currentEntries.value.some((e) => e.id === a.id), "оригинал остался на месте");
});

test("cutSelection/pasteHere: узел ПЕРЕМЕЩАЕТСЯ (не копируется), тот же id", async () => {
	const container = await createFolder("Контейнер");
	openFolder(container.id);
	const a = await createFolder("A");
	const b = await createFolder("B");
	cutSelection([a.id]);
	openFolder(b.id);
	await pasteHere();

	assert.equal(currentEntries.value.length, 1);
	assert.equal(currentEntries.value[0].id, a.id, "перемещение сохраняет id");

	openFolder(container.id);
	assert.ok(!currentEntries.value.some((e) => e.id === a.id), "оригинала в исходной папке больше нет");
});

test("pasteHere с Cut: узел, удалённый другой репликой ДО paste — no-op для него, не ошибка (§4.1 MATH.md)", async () => {
	const container = await createFolder("Контейнер");
	openFolder(container.id);
	const a = await createFolder("A");
	const b = await createFolder("B");
	cutSelection([a.id]);
	await purgeNode(a.id); // "другая реплика" удалила узел насовсем, пока он в буфере
	const parLabelBefore = { ...treeState.value.nodes.get(a.id).par.label };

	openFolder(b.id);
	await assert.doesNotReject(() => pasteHere());
	assert.equal(currentEntries.value.length, 0, "purged-узел не 'воскрес' вставкой");
	// Сильнее, чем просто "не виден": операция НЕ должна была вообще
	// сконструироваться для purged-узла (project() и сам не показал бы его
	// независимо от par — эта проверка ловит именно отсутствие лишнего
	// setPar, а не только видимость в UI).
	assert.deepEqual(
		treeState.value.nodes.get(a.id).par.label,
		parLabelBefore,
		"метка par purged-узла не должна была измениться — операция для него не строилась вовсе",
	);
});
