import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { createFolder as opCreateFolder, createFile as opCreateFile, rename as opRename, move as opMove, purge as opPurge } from "../src/domain/files/ops.js";
import { createInitialState, ROOT_ID } from "../src/domain/files/tree.js";
import { buildFilesLogEvent, parseFilesLogEvent, KIND_FILES_OP } from "../src/domain/files/sync.js";
import { getFileKey, listUnannouncedFileKeys } from "../src/domain/files/store.js";
import { privKeySig, dbKeySig } from "../src/ui/signals/auth.js";
import { initFiles, treeState, projected, createFolder, createFileEntry, rebuildFilesLog, backfillOwnFileKeys } from "../src/ui/signals/files.js";

const OWNER_PRIV = new Uint8Array(32).fill(7);
const { getPublicKey } = await import("../src/core/crypto/keys.js");
const { bytesToHex } = await import("@noble/hashes/utils.js");
const OWNER = bytesToHex(getPublicKey(OWNER_PRIV));

function noopPublish() {
	return Promise.resolve({ ok: true });
}

async function seedEvent(ops, deviceSuffix = "a") {
	const event = buildFilesLogEvent(OWNER_PRIV, ops);
	await db.table("events").add({ ...event, flatTags: [] });
	return event;
}

function label(counter, deviceId = "device-a") {
	return { counter, deviceId };
}

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("files_nodes").clear();
	await db.table("clock").clear();
	await db.table("files_keys").clear();
	await db.table("events").where("pubkey").equals(OWNER).delete();
	dbKeySig.value = crypto.getRandomValues(new Uint8Array(32));
	privKeySig.value = OWNER_PRIV;
});

test("buildFilesLogEvent/parseFilesLogEvent: round-trip для create-операции", () => {
	const ops = [{ type: "create", id: "n-1", kind: "dir", blob: null, parentId: ROOT_ID, name: "Заметки", origin: null, label: label(1) }];
	const event = buildFilesLogEvent(OWNER_PRIV, ops);
	assert.equal(event.kind, KIND_FILES_OP);
	const parsed = parseFilesLogEvent(event, OWNER_PRIV);
	assert.deepEqual(parsed, ops);
});

test("buildFilesLogEvent/parseFilesLogEvent: round-trip для purge (БЕЗ label)", () => {
	const ops = [{ type: "purge", id: "n-1" }];
	const event = buildFilesLogEvent(OWNER_PRIV, ops);
	const parsed = parseFilesLogEvent(event, OWNER_PRIV);
	assert.deepEqual(parsed, ops);
});

test("rebuildFilesLog: no-op, если initFiles ещё не вызывался для этого owner", async () => {
	await seedEvent([opCreateFolder(createInitialState(), ROOT_ID, "Тест", "n-1", label(1))]);
	await assert.doesNotReject(() => rebuildFilesLog(OWNER, OWNER_PRIV));
});

test("rebuildFilesLog: применяет операции из одного события", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	const op = opCreateFolder(treeState.value, ROOT_ID, "Из другого устройства", "n-remote-1", label(1));
	await seedEvent([op]);

	await rebuildFilesLog(OWNER, OWNER_PRIV);

	const R = projected.value;
	const names = (R.children.get(ROOT_ID) ?? []).map((id) => R.nodes.get(id).displayName);
	assert.ok(names.includes("Из другого устройства"));
});

test("rebuildFilesLog: пакетное применение НЕСКОЛЬКИХ событий даёт тот же результат, что и напрямую merge() (порядок обхода не важен)", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	const S0 = treeState.value;
	const opA = opCreateFolder(S0, ROOT_ID, "A", "n-a", label(1, "device-a"));
	const opB = opCreateFolder(S0, ROOT_ID, "B", "n-b", label(2, "device-a"));
	// opRename конструируется против состояния, где "n-a" уже существует
	// (сама операция rename ДОСТАВЛЯЕТСЯ позже отдельным событием, но
	// строится она локально на устройстве, которое уже применило create).
	const { merge: mergeForSetup } = await import("../src/domain/files/tree.js");
	const S1 = mergeForSetup(S0, [opA]);
	const opRenameA = opRename(S1, "n-a", "A-переименовано", label(3, "device-a"));

	// Три СОБЫТИЯ, разбитые произвольно (не одно на операцию, не все в одном) —
	// порядок доставки/фолда не должен влиять на итог (DESIGN.md, "гонка" сетевого слоя).
	await seedEvent([opB]);
	await seedEvent([opA]);
	await seedEvent([opRenameA]);

	await rebuildFilesLog(OWNER, OWNER_PRIV);

	const R = projected.value;
	const names = (R.children.get(ROOT_ID) ?? []).map((id) => R.nodes.get(id).displayName).sort();
	assert.deepEqual(names, ["A-переименовано", "B", "lost+found", "Корзина"].sort());
});

test("rebuildFilesLog: идемпотентен — повторный вызов на ТЕХ ЖЕ событиях не меняет treeState", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	await seedEvent([opCreateFolder(treeState.value, ROOT_ID, "Раз", "n-1", label(1))]);

	await rebuildFilesLog(OWNER, OWNER_PRIV);
	const after1 = JSON.stringify([...projected.value.nodes.entries()]);
	await rebuildFilesLog(OWNER, OWNER_PRIV);
	const after2 = JSON.stringify([...projected.value.nodes.entries()]);

	assert.equal(after1, after2);
});

test("rebuildFilesLog: одно повреждённое событие не мешает применить остальные валидные", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	const goodOp = opCreateFolder(treeState.value, ROOT_ID, "Валидная", "n-good", label(1));
	await seedEvent([goodOp]);
	// Повреждённое событие того же kind — контент не расшифровывается (не NIP-44 вовсе).
	await db.table("events").add({
		id: "broken-event-id",
		pubkey: OWNER,
		kind: KIND_FILES_OP,
		content: "не-nip44-мусор",
		created_at: Math.floor(Date.now() / 1000),
		tags: [],
		sig: "0".repeat(128),
		flatTags: [],
	});

	await assert.doesNotReject(() => rebuildFilesLog(OWNER, OWNER_PRIV));
	const R = projected.value;
	const names = (R.children.get(ROOT_ID) ?? []).map((id) => R.nodes.get(id).displayName);
	assert.ok(names.includes("Валидная"), "валидное событие рядом с повреждённым обязано примениться");
});

test("rebuildFilesLog: lamportClock.receive использует МАКСИМАЛЬНЫЙ counter, не последний по порядку обхода", async () => {
	// publish=undefined — этот тест проверяет Lamport-гигиену, не публикацию;
	// без этого локальный createFolder() ниже поставил бы в очередь дребезга
	// таймер, который мог бы всплыть в СЛЕДУЮЩЕМ тесте (утечка между тестами).
	await initFiles(OWNER, OWNER_PRIV, undefined);
	// Порядок обхода НЕ совпадает с порядком по counter — максимум (10) идёт ПЕРВЫМ.
	await seedEvent([opCreateFolder(treeState.value, ROOT_ID, "Высокий", "n-high", label(10))]);
	await seedEvent([opCreateFolder(treeState.value, ROOT_ID, "Низкий", "n-low", label(2))]);

	await rebuildFilesLog(OWNER, OWNER_PRIV);

	// Следующая ЛОКАЛЬНАЯ операция обязана получить counter > 10 (не > 2).
	const op = await createFolder("Локальная-после-приёма");
	assert.ok(op.label.counter > 10, `ожидался counter > 10, получено ${op.label.counter}`);
});

test("дребезг публикации: несколько быстрых локальных правок дают ОДНО сетевое событие", async () => {
	const published = [];
	const spyPublish = (event) => {
		published.push(event);
		return Promise.resolve({ ok: true });
	};
	await initFiles(OWNER, OWNER_PRIV, spyPublish);

	await createFolder("Первая");
	await createFolder("Вторая");
	await createFolder("Третья");
	assert.equal(published.length, 0, "публикация не должна была ещё случиться — окно дребезга не истекло");

	await new Promise((r) => setTimeout(r, 400)); // дать дребезгу (300мс) осесть

	assert.equal(published.length, 1, "три быстрых правки должны были схлопнуться в ОДНО событие");
	const parsed = parseFilesLogEvent(published[0], OWNER_PRIV);
	assert.equal(parsed.length, 3, "событие обязано нести ВСЕ три операции");
	assert.deepEqual(
		parsed.map((op) => op.name),
		["Первая", "Вторая", "Третья"],
	);
});

test("дребезг публикации: правка ПОСЛЕ паузы даёт ВТОРОЕ отдельное событие", async () => {
	const published = [];
	const spyPublish = (event) => {
		published.push(event);
		return Promise.resolve({ ok: true });
	};
	await initFiles(OWNER, OWNER_PRIV, spyPublish);

	await createFolder("Первая волна");
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(published.length, 1);

	await createFolder("Вторая волна");
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(published.length, 2, "правка после того, как первое окно уже истекло, обязана дать НОВОЕ событие");
});

test("дребезг публикации: сбой publish() не бросает наружу (best-effort, тот же принцип, что saveUiSettings)", async () => {
	const failingPublish = () => Promise.reject(new Error("relay недоступен (симуляция)"));
	await initFiles(OWNER, OWNER_PRIV, failingPublish);

	await createFolder("Локальная, несмотря на сбой сети");
	await new Promise((r) => setTimeout(r, 400)); // дать flushPendingOps упасть внутри — не должно быть unhandledRejection

	const R = projected.value;
	const names = (R.children.get(ROOT_ID) ?? []).map((id) => R.nodes.get(id).displayName);
	assert.ok(names.includes("Локальная, несмотря на сбой сети"), "локальное состояние применяется ДО публикации, сбой сети его не откатывает");
});

test("rebuildFilesLog: purge-операции (без label) не ломают вычисление maxCounter", async () => {
	await initFiles(OWNER, OWNER_PRIV, undefined); // см. комментарий выше — без публикации не нужен таймер
	const S0 = treeState.value;
	const created = opCreateFolder(S0, ROOT_ID, "К удалению", "n-del", label(5));
	await seedEvent([created]);
	await rebuildFilesLog(OWNER, OWNER_PRIV);
	// purge — БЕЗ label, отдельным событием, идущим ПОСЛЕДНИМ по обходу.
	await seedEvent([opPurge(treeState.value, "n-del")]);

	await assert.doesNotReject(() => rebuildFilesLog(OWNER, OWNER_PRIV));
	const op = await createFolder("После purge");
	assert.ok(op.label.counter > 5, `purge не должен был обнулить/сломать maxCounter, получено ${op.label.counter}`);
});

// Этап 57 — журнал уже NIP-44-шифруется владельцем самому себе, поэтому
// create-Op может безопасно нести fileKey; второе устройство, реплеивший этот
// журнал (rebuildFilesLog), обязано сохранить ключ локально — без этого файл
// виден в дереве, но НИКОГДА не расшифровывается (найдено живой проверкой).
test("rebuildFilesLog: create-операция с fileKey из УДАЛЁННОГО события -> ключ сохраняется локально", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	const fileKeyBytes = crypto.getRandomValues(new Uint8Array(32));
	const fileKeyHex = bytesToHex(fileKeyBytes);
	const op = opCreateFile(treeState.value, ROOT_ID, "фото-с-другого-устройства.jpg", "n-remote-file", "digest-remote", label(1), null, fileKeyHex);
	await seedEvent([op]);

	await rebuildFilesLog(OWNER, OWNER_PRIV);

	const got = await getFileKey(OWNER, dbKeySig.value, "digest-remote");
	assert.deepEqual(got, fileKeyBytes, "ключ из удалённой create-операции обязан оказаться в files_keys этого устройства");
});

test("rebuildFilesLog: create-операция БЕЗ fileKey -> files_keys не трогается (обычный случай, структура синкается, ключ — нет)", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	const op = opCreateFile(treeState.value, ROOT_ID, "обычный.jpg", "n-remote-file-2", "digest-remote-2", label(1));
	await seedEvent([op]);

	await rebuildFilesLog(OWNER, OWNER_PRIV);

	assert.equal(await getFileKey(OWNER, dbKeySig.value, "digest-remote-2"), undefined);
});

test("rebuildFilesLog: fileKey из удалённого события НЕ перезаписывает уже известный локально ключ того же digest", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	const localKey = crypto.getRandomValues(new Uint8Array(32));
	await createFileEntry("уже-есть.jpg", "digest-shared", localKey);

	const foreignKeyHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
	const op = opCreateFile(treeState.value, ROOT_ID, "дубль-с-другого-устройства.jpg", "n-remote-file-3", "digest-shared", label(1), null, foreignKeyHex);
	await seedEvent([op]);

	await rebuildFilesLog(OWNER, OWNER_PRIV);

	const got = await getFileKey(OWNER, dbKeySig.value, "digest-shared");
	assert.deepEqual(got, localKey, "уже известный локально ключ не должен быть затёрт чужой версией из журнала");
});

// backfillOwnFileKeys — задним числом довыдаёт ключ файлам, чей create-Op был
// опубликован ДО этого фикса (без fileKey).
test("backfillOwnFileKeys: файл, чей create-Op не нёс fileKey — republish-ится с ключом, помечается announced", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	const fileKey = crypto.getRandomValues(new Uint8Array(32));
	// createFileEntry уже помечает announced=true (ключ едет с самого начала) —
	// имитируем "старый" файл, созданный ДО фикса: announced=false вручную.
	const { saveFileKey } = await import("../src/domain/files/store.js");
	await createFileEntry("старый-файл.jpg", "digest-old", fileKey);
	await saveFileKey(OWNER, dbKeySig.value, "digest-old", fileKey, false);

	const published = [];
	const spyPublish = (event) => {
		published.push(event);
		return Promise.resolve({ ok: true });
	};
	const count = await backfillOwnFileKeys(OWNER, OWNER_PRIV, spyPublish);
	assert.equal(count, 1);

	assert.equal(published.length, 1);
	const parsed = parseFilesLogEvent(published[0], OWNER_PRIV);
	const createOp = parsed.find((o) => o.type === "create" && o.blob === "digest-old");
	assert.ok(createOp, "republish обязан нести create-операцию с тем же digest");
	assert.equal(createOp.fileKey, bytesToHex(fileKey));

	assert.deepEqual(await listUnannouncedFileKeys(OWNER, dbKeySig.value), []);
});

test("backfillOwnFileKeys: уже announced ключ -> не публикует повторно, возвращает 0", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	const fileKey = crypto.getRandomValues(new Uint8Array(32));
	await createFileEntry("новый-файл.jpg", "digest-new", fileKey); // announced=true по умолчанию

	const published = [];
	const count = await backfillOwnFileKeys(OWNER, OWNER_PRIV, (e) => {
		published.push(e);
		return Promise.resolve({ ok: true });
	});
	assert.equal(count, 0);
	assert.equal(published.length, 0);
});

test("backfillOwnFileKeys: нет файлов вовсе -> 0, не бросает", async () => {
	await initFiles(OWNER, OWNER_PRIV, noopPublish);
	await assert.doesNotReject(async () => {
		const count = await backfillOwnFileKeys(OWNER, OWNER_PRIV, noopPublish);
		assert.equal(count, 0);
	});
});
