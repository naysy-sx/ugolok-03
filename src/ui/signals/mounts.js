// Мост между domain/files/mount.js и UI — сторона ПОЛУЧАТЕЛЯ доли (CONTRACTS.md,
// этап 53 И6, задача 6.7). Узел-ссылка смонтированной доли — ОБЫЧНАЯ операция
// над ТЕМ ЖЕ деревом, что files.js (CONTRACTS.md 6.3) — переиспользует
// files.js's label()/applyAndPersist() (экспортированы специально для этого),
// а не заводит второй независимый Лампорт-счётчик/публикацию (два независимых
// счётчика ОДНОГО дерева разошлись бы — JS однопоточен, единый lamportClock
// в files.js гарантирует, что ЛЮБЫЕ "параллельные" вызовы label() сериализуются
// на разные counter, откуда бы их ни звали).
import { signal, computed } from "@preact/signals";
import { treeState, label as filesLabel, applyAndPersist, collectNewIds } from "./files.js";
import { decryptShareGrant } from "../../core/crypto/share-key.js";
import { mount, applyMountSubtreeEvent, unmount, resolveMountFileKey } from "../../domain/files/mount.js";
import { saveToOwn } from "../../domain/files/save-to-own.js";
import { listMounts, loadMountState } from "../../domain/files/store.js";
import { ROOT_ID, project } from "../../domain/files/tree.js";
import { purge } from "../../domain/files/ops.js";

export const activeMounts = signal([]); // [{mountId, ownerPubkey, rootId, currentVersion}]
export const mountProjections = signal(new Map()); // mountId -> project(mountState), заполняется по требованию (ensureMountProjection)

// rootId'ы, на которые transport.js подписывается по тегу #h (FILE_SUBTREE_OP_KIND) —
// тот же паттерн, что channels' topics (refreshChannelContentSubscription).
export const activeMountRootIds = computed(() => activeMounts.value.map((m) => m.rootId));

function randomNodeId() {
	return crypto.getRandomValues(new Uint8Array(16)).reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "n-");
}

// Читает уже существующие files_mounts — вызывается РАНО (при connect(),
// НЕ при открытии экрана "Файлы": в отличие от rebuildFilesLog, входящие
// доли обрабатываются постоянным подписчиком, активным независимо от
// экрана — activeMounts обязан быть заполнен ДО первой подписки на #h).
export async function initMounts(recipientPubkey, dbKey) {
	const rows = await listMounts(recipientPubkey, dbKey);
	activeMounts.value = rows.map((r) => ({ mountId: r.nodeId, ownerPubkey: r.owner, rootId: r.rootId, currentVersion: r.currentVersion }));
}

// Входящий FILE_SHARE_GRANT_KIND (грант владельца доли, тег #p=я). Идемпотентно:
// (owner, rootId) уже среди activeMounts -> no-op (redelivery/переподписка —
// тот же принцип, что isNewEvent в transport.js, только на уровне домена, не
// событий: повторный ГРАНТ той же доли — обычный случай при share() на нового
// СОВМЕСТНОГО читателя, не должен создавать ВТОРОЙ узел-ссылку).
export async function handleIncomingShareGrant(recipientPubkey, recipientPrivKey, dbKey, grantEvent, defaultName) {
	const ownerPubkey = grantEvent.pubkey;
	let decrypted;
	try {
		decrypted = decryptShareGrant(grantEvent.content, recipientPrivKey, ownerPubkey);
	} catch {
		return; // не мой грант / повреждён — рутинный случай relay-потока
	}
	if (activeMounts.value.some((m) => m.ownerPubkey === ownerPubkey && m.rootId === decrypted.nodeId)) return;

	const newMountId = randomNodeId();
	let name = defaultName;
	let result;
	for (let attempt = 1; attempt <= 5; attempt++) {
		result = await mount(recipientPubkey, recipientPrivKey, dbKey, treeState.value, grantEvent, ROOT_ID, name, newMountId, await filesLabel(recipientPubkey));
		if (!(result instanceof Error)) break;
		name = `${defaultName} (${attempt + 1})`;
	}
	if (result instanceof Error) return; // маловероятная затяжная коллизия имён — не бросаем, рутинный no-op

	await applyAndPersist([result.op], recipientPubkey);
	activeMounts.value = [...activeMounts.value, { mountId: result.mountId, ownerPubkey: result.ownerPubkey, rootId: result.rootId, currentVersion: result.version }];
}

// Входящий FILE_SUBTREE_OP_KIND, маршрутизация по тегу #h -> mountId (может
// быть НЕСКОЛЬКО активных долей одновременно — событие относится к ровно
// одной, по rootId). Пересчитывает mountProjections ТОЛЬКО если получатель
// уже смотрит эту долю (ensureMountProjection её туда положила) — иначе
// пересчёт не нужен, при следующем открытии projection соберётся заново
// из БД (Mount.state и так уже обновлён applyMountSubtreeEvent).
export async function handleIncomingSubtreeEvent(recipientPubkey, dbKey, event) {
	const rootId = event.tags.find((t) => t[0] === "h")?.[1];
	const mountEntry = activeMounts.value.find((m) => m.rootId === rootId);
	if (!mountEntry) return; // доля ещё не смонтирована/не наша — обычный broadcast-поток

	const S = await applyMountSubtreeEvent(recipientPubkey, dbKey, mountEntry.mountId, event);
	if (S === null) return;
	if (mountProjections.value.has(mountEntry.mountId)) {
		mountProjections.value = new Map(mountProjections.value).set(mountEntry.mountId, project(S));
	}
}

// Подгружает/пересчитывает проекцию доли по требованию (открытие раздела
// "Полученные доли" в UI) — Mount.state не держится в памяти постоянно,
// читается из IndexedDB (доли малы по конструкции, ALGO.MD).
export async function ensureMountProjection(recipientPubkey, mountId) {
	const S = await loadMountState(recipientPubkey, mountId);
	mountProjections.value = new Map(mountProjections.value).set(mountId, project(S));
}

// "Сохранить себе" (6.6) — resolveFileKey подставлен ЗДЕСЬ, готовым
// resolveMountFileKey (6.6b), UI не занимается криптографией напрямую.
// Результат — Op[] применяется К СВОЕМУ дереву получателя (files.js),
// destParentId — узел В ЭТОМ дереве (обычно currentFolderId.value).
export async function saveMountedItemToOwn(recipientPubkey, dbKey, mountId, nodeId, destParentId, opts) {
	const mountState = await loadMountState(recipientPubkey, mountId);
	const newIds = collectNewIds(mountState, nodeId);
	const resolveFileKey = (node) => resolveMountFileKey(recipientPubkey, dbKey, mountId, node.id);
	const ops = await saveToOwn(recipientPubkey, dbKey, mountState, nodeId, treeState.value, destParentId, newIds, resolveFileKey, await filesLabel(recipientPubkey), opts);
	await applyAndPersist(ops, recipientPubkey);
	return ops;
}

// Размонтирование — purge узла-ссылки В СВОЁМ дереве (через ту же
// applyAndPersist, что любая другая операция) + удаление служебных таблиц
// доли (mount.js's unmount, вызвана ради storage-cleanup — её собственный
// purge поверх уже purged-узла идемпотентен, безопасное дублирование).
export async function unmountShare(recipientPubkey, dbKey, mountId) {
	const op = purge(treeState.value, mountId);
	await applyAndPersist([op], recipientPubkey);
	await unmount(recipientPubkey, dbKey, treeState.value, mountId);

	activeMounts.value = activeMounts.value.filter((m) => m.mountId !== mountId);
	const next = new Map(mountProjections.value);
	next.delete(mountId);
	mountProjections.value = next;
}
