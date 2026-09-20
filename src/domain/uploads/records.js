// ТЗ-03 — журнал загрузок: чистая логика записей (без I/O, без Dexie).
//
// Журнал — последовательность ОПЕРАЦИЙ, разложенных по пачкам (batches.js):
//   add    — заливка блоба (одно вложение с превью даёт четыре add с общим group);
//   target — тот же блоб отправлен ещё куда-то (дедупликация/повторная ссылка);
//   del    — блоб удалён с сервера (надгробие для пачек ДРУГИХ устройств).
// Текущее состояние («что я залил») — свёртка операций по порядку времени. Свёртка
// детерминирована и не зависит от того, в каких пачках лежат операции, поэтому пачки
// разных устройств сливаются простым объединением.

export const ROLES = ["content", "manifest", "preview", "previewManifest"];
export const PURPOSES = ["dm", "group", "channel", "files", "share", "avatar"];

const MAX_NAME = 120;
const MAX_STR = 200;
const HASH_RE = /^[0-9a-f]{64}$/;

const OP_RANK = { add: 0, target: 1, del: 2 };

function str(v, max = MAX_STR) {
	if (typeof v !== "string") return undefined;
	return v.length > max ? v.slice(0, max) : v;
}

export function newGroupId() {
	const b = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Приводит входную запись к операции add; невалидное -> null (журнал не должен
// ломать заливку, поэтому здесь не throw).
export function makeAdd(e, now = Date.now()) {
	if (!e || typeof e.hash !== "string" || !HASH_RE.test(e.hash)) return null;
	const size = Number(e.size);
	if (!Number.isFinite(size) || size < 0) return null;
	if (!ROLES.includes(e.role)) return null;
	if (!PURPOSES.includes(e.purpose)) return null;
	const op = {
		op: "add",
		hash: e.hash,
		size,
		at: Number.isFinite(e.at) ? e.at : now,
		role: e.role,
		group: str(e.group, 64) ?? newGroupId(),
		purpose: e.purpose,
		target: str(e.target) ?? "",
	};
	const name = str(e.name, MAX_NAME);
	if (name) op.name = name;
	const server = str(e.server);
	if (server) op.server = server;
	const src = str(e.sourceDigest, 64);
	if (src && HASH_RE.test(src)) op.sourceDigest = src;
	return op;
}

export function makeTarget(hash, target, now = Date.now()) {
	if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
	const t = str(target);
	if (!t) return null;
	return { op: "target", hash, target: t, at: now };
}

export function makeDel(hash, now = Date.now()) {
	if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
	return { op: "del", hash, at: now };
}

// Операция из чужой пачки: проверяем форму, лишнее выбрасываем.
export function sanitizeOp(raw) {
	if (!raw || typeof raw !== "object") return null;
	if (raw.op === "add") return makeAdd(raw, Number.isFinite(raw.at) ? raw.at : 0);
	if (raw.op === "target") {
		const o = makeTarget(raw.hash, raw.target, Number.isFinite(raw.at) ? raw.at : 0);
		return o;
	}
	if (raw.op === "del") return makeDel(raw.hash, Number.isFinite(raw.at) ? raw.at : 0);
	return null;
}

// Применяет ОДНУ операцию к Map hash -> строка (общий код свёртки и инкрементального
// обновления локальной таблицы: семантика не должна расходиться).
export function applyOp(rows, op) {
	if (op.op === "add") {
		const prev = rows.get(op.hash);
		// Повторная заливка того же хеша: запись не дублируется, `at` обновляется,
		// цель добавляется, если новая.
		if (prev) {
			prev.at = Math.max(prev.at, op.at);
			if (op.target && !prev.targets.includes(op.target)) prev.targets.push(op.target);
			return;
		}
		rows.set(op.hash, {
			hash: op.hash,
			size: op.size,
			at: op.at,
			role: op.role,
			group: op.group,
			purpose: op.purpose,
			targets: op.target ? [op.target] : [],
			name: op.name,
			server: op.server,
			sourceDigest: op.sourceDigest,
		});
	} else if (op.op === "target") {
		const row = rows.get(op.hash);
		if (row && !row.targets.includes(op.target)) row.targets.push(op.target);
	} else if (op.op === "del") {
		rows.delete(op.hash);
	}
}

// Свёртка: ops — массив операций (порядок в массиве — запасной ключ сортировки).
// Возвращает Map hash -> строка журнала.
export function foldOps(ops) {
	const indexed = ops.map((op, i) => ({ op, i }));
	indexed.sort((a, b) => a.op.at - b.op.at || OP_RANK[a.op.op] - OP_RANK[b.op.op] || a.i - b.i);
	const rows = new Map();
	for (const { op } of indexed) applyOp(rows, op);
	return rows;
}

// Вложение = группа записей с общим group.
export function groupRows(rows) {
	const groups = new Map();
	for (const row of rows) {
		let g = groups.get(row.group);
		if (!g) {
			g = { group: row.group, rows: [], size: 0, at: 0, name: undefined, purpose: row.purpose, targets: [], sourceDigest: undefined };
			groups.set(row.group, g);
		}
		g.rows.push(row);
		g.size += row.size;
		g.at = Math.max(g.at, row.at);
		if (row.role === "content" && row.name) g.name = row.name;
		else if (!g.name && row.name && row.role !== "preview" && row.role !== "previewManifest") g.name = row.name;
		if (row.sourceDigest && !g.sourceDigest) g.sourceDigest = row.sourceDigest;
		for (const t of row.targets) if (!g.targets.includes(t)) g.targets.push(t);
	}
	return groups;
}

const EXT = {
	image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "bmp", "svg"],
	video: ["mp4", "webm", "mov", "mkv", "avi", "m4v"],
	audio: ["mp3", "ogg", "oga", "wav", "m4a", "aac", "flac", "weba", "opus"],
	document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "json", "rtf", "odt"],
};

// Тип файла по имени (с сервера типа не получить — там всё octet-stream).
export function classOfName(name) {
	if (typeof name !== "string") return "other";
	const m = /\.([a-z0-9]{1,5})$/i.exec(name);
	if (!m) return "other";
	const ext = m[1].toLowerCase();
	for (const [cls, list] of Object.entries(EXT)) if (list.includes(ext)) return cls;
	return "other";
}
