// Конструкторы операций дерева файлов — чистая логика, БЕЗ I/O (CONTRACTS.md,
// этап 53, §5.2 TASK.md). Метка и (где нужно) новый NodeId — готовые
// значения от вызывающей стороны (см. CONTRACTS.md: генерация случайности —
// эффект, здесь недопустим). Предусловия — §4 TASK.md/MATH.md, ровно источник
// unit-тестов tree-ops.test.js.
import { TRASH_ID, liveChildrenOf, nameOwnerInDir } from "./tree.js";

// key/params (этап 65, i18n доменных ошибок) — опциональны, для UI-рендера
// через errorMessage()/t(); code — как раньше, для программной проверки
// причины (NAME_TAKEN/CYCLE), не для отображения.
export class PreconditionError extends Error {
	constructor(code, message, key, params) {
		super(message);
		this.name = "PreconditionError";
		this.code = code;
		this.key = key;
		this.params = params;
	}
}

// O(1) через индекс S.namesInDir (tree.js) — НЕ скан S.nodes. Найдено
// бенчмарком (задача 3.9): полный скан на каждый вызов давал Θ(n²) на
// массовой загрузке (ровно ловушка ALGO.MD §14, первая строка таблицы) —
// n=10⁵ не укладывался в разумное время.
function nameFree(S, parentId, name, excludeId = null) {
	const owner = nameOwnerInDir(S, parentId, name);
	return owner === undefined || owner === excludeId;
}

// d ∉ subtree(n): восхождением от d, а не спуском по n (ALGO.MD §7) — O(D),
// не O(|subtree|). Предел — "жёсткий" щит от бесконечного цикла на уже
// испорченном сыром S (ремонт ещё не применён); НЕ бросает при превышении —
// предусловие обязано быть тотальной функцией даже на нарушенном I-ACYCLIC
// состоянии (DESIGN.md, "Этап 53, И1").
// Экспортирована (этап 53 И7-довесок, drag-and-drop): §7 TASK.md п.211
// требует ЖИВУЮ проверку d∉subtree(n) "на каждый кадр наведения" — UI
// подсвечивает недопустимую цель ДО drop, не только ловит PreconditionError
// постфактум. Поведение move() не меняется — чистое добавление экспорта.
const ASCEND_LIMIT = 128;
export function targetInsideSubtree(S, n, d) {
	let cur = d;
	let steps = 0;
	while (cur !== null && cur !== undefined && steps < ASCEND_LIMIT) {
		if (cur === n) return true;
		const node = S.nodes.get(cur);
		if (!node) return false;
		cur = node.par.value;
		steps++;
	}
	return false;
}

export function createFolder(S, parentId, name, newId, label) {
	if (!nameFree(S, parentId, name)) {
		return new PreconditionError("NAME_TAKEN", `Имя "${name}" уже занято в этой папке`, "errors.nameTakenInFolder", { name });
	}
	return { type: "create", id: newId, kind: "dir", blob: null, parentId, name, origin: null, label };
}

// Узел-файл — та же проверка имени, что у папки; blob — дайджест манифеста
// (content.js's putStream), НЕИЗМЕНЯЕМ после создания, как и kind (§4.1
// TASK.md). origin — пассивная метка происхождения (§4.1: "узел из чата" и
// т.п.), опциональна, по умолчанию null (обычная загрузка через "Файлы").
// Этап 57 — fileKeyHex (необязательный) едет ВНУТРИ уже NIP-44-самошифрованного
// журнала операций (sync.js) — второе устройство того же владельца иначе видит
// digest, но никогда не сможет расшифровать содержимое (найдено живой проверкой).
export function createFile(S, parentId, name, newId, blob, label, origin = null, fileKeyHex = null) {
	if (!nameFree(S, parentId, name)) {
		return new PreconditionError("NAME_TAKEN", `Имя "${name}" уже занято в этой папке`, "errors.nameTakenInFolder", { name });
	}
	const fileKey = fileKeyHex !== undefined && fileKeyHex !== null ? { fileKey: fileKeyHex } : {};
	return { type: "create", id: newId, kind: "file", blob, parentId, name, origin, label, ...fileKey };
}

export function rename(S, id, name, label) {
	const node = S.nodes.get(id);
	const parentId = node.par.value;
	if (!nameFree(S, parentId, name, id)) {
		return new PreconditionError("NAME_TAKEN", `Имя "${name}" уже занято в этой папке`, "errors.nameTakenInFolder", { name });
	}
	return { type: "setName", id, value: name, label };
}

export function move(S, id, newParentId, label) {
	if (targetInsideSubtree(S, id, newParentId)) {
		return new PreconditionError("CYCLE", "Нельзя переместить папку саму в себя или в своё поддерево", "errors.cannotMoveIntoOwnSubtree");
	}
	const name = S.nodes.get(id).name.value;
	if (!nameFree(S, newParentId, name, id)) {
		return new PreconditionError("NAME_TAKEN", `Имя "${name}" уже занято в целевой папке`, "errors.nameTakenInTargetFolder", { name });
	}
	return { type: "setPar", id, value: newParentId, label };
}

// copy(n, d) -> Op[] — ТОТАЛЬНА (§4 TASK.md: условие d∉subtree(n) здесь не
// требуется — копия конечна и корректна даже "в себя"). При коллизии имени
// у КОРНЯ копии автоматически добавляется суффикс " (копия)" — это и есть
// то, что делает функцию тотальной, а не PreconditionError.
// newIds: Map<исходный NodeId, новый NodeId> — по ВСЕМУ поддереву n
// (включая сам n), сгенерировано вызывающей стороной (случайность — эффект).
export function copy(S, n, destId, newIds, label) {
	// Снимок поддерева n по СЫРЫМ (не проецированным) live-указателям par —
	// §3.2 MATH.md: копирование — биекция на снимке, независимая от того,
	// что случится с оригиналом дальше.
	const subtreeIds = [];
	const stack = [n];
	while (stack.length > 0) {
		const cur = stack.pop();
		subtreeIds.push(cur);
		for (const id of liveChildrenOf(S, cur)) stack.push(id);
	}

	const rootOriginal = S.nodes.get(n);
	let rootName = rootOriginal.name.value;
	if (!nameFree(S, destId, rootName)) {
		rootName = `${rootName} (копия)`;
		// Крайне маловероятная, но не невозможная повторная коллизия —
		// дозаполняем числом, детерминированно и конечно.
		let i = 2;
		while (!nameFree(S, destId, rootName)) {
			rootName = `${rootOriginal.name.value} (копия ${i})`;
			i += 1;
		}
	}

	const ops = [];
	for (const id of subtreeIds) {
		const node = S.nodes.get(id);
		const newId = newIds.get(id);
		const parentId = id === n ? destId : newIds.get(node.par.value);
		const name = id === n ? rootName : node.name.value;
		ops.push({
			type: "create",
			id: newId,
			kind: node.kind,
			blob: node.blob,
			parentId,
			name,
			origin: node.origin.value,
			label,
		});
	}
	return ops;
}

// remove(n) ≡ move(n, /trash) — ТОТАЛЬНА (§4 TASK.md: сигнатура remove не
// содержит PreconditionError, в отличие от move). Сознательно НЕ переиспользует
// move() буквально: та применяет проверку имени, а remove обязана всегда
// успевать — коллизию имён внутри корзины разруливает шаг 3 project()
// (суффиксы), это ровно то, для чего он существует (MATH.md §5.6).
export function remove(S, id, label) {
	return { type: "setPar", id, value: TRASH_ID, label };
}

export function purge(S, id) {
	return { type: "purge", id };
}
