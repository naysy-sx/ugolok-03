// CRDT-дерево файлов — чистая логика, БЕЗ I/O (CONTRACTS.md, этап 53, §3.3
// TASK.md). Формализация и обоснование каждого шага — DESIGN.md, "Этап 53,
// И1". Три системных узла существуют с самого начала состояния — их
// размещение (в частности lost+found как отдельный узел vs подпапка корзины)
// оставлено открытым вопросом до И3 (MATH.md §12.4), здесь — просто три
// зарезервированных NodeId.
import { classOf, CLASS_INDEX } from "../media/media-ref.js";

export const ROOT_ID = "$root";
export const TRASH_ID = "$trash";
export const LOST_FOUND_ID = "$lost+found";

// Метка — (счётчик Лампорта, deviceId). Тотальный порядок ⟺ deviceId
// уникален между устройствами (гарантируется getOrCreateDeviceId(),
// domain/identity/device.js — 128 бит случайности, не переиспользуется
// здесь напрямую: tree.js не делает I/O, метку строит вызывающая сторона).
export function compareLabels(a, b) {
	if (a.counter !== b.counter) return a.counter - b.counter;
	if (a.deviceId === b.deviceId) return 0;
	return a.deviceId < b.deviceId ? -1 : 1;
}

function lwwMerge(reg, value, label) {
	if (!reg || compareLabels(label, reg.label) > 0) return { value, label };
	return reg;
}

function mkNode(id, kind, blob, parValue, nameValue, label, originValue = null, mimeValue = null) {
	return {
		id,
		kind,
		blob,
		par: { value: parValue, label },
		name: { value: nameValue, label },
		origin: { value: originValue, label },
		purged: false,
		mime: mimeValue,
	};
}

// classCount — индекс parentId → Int32Array(4) ([audio,video,image,other],
// CLASS_INDEX из media-ref.js), по образцу children/namesInDir (ALGO.MD
// §3.5, DESIGN.md "Этап E, E1"). Класс узла неизменяем (MEDIA-MATH.md
// Утв. 8), поэтому поддержка — чистый +1/-1, без разбора случаев.
function addClassCount(classCount, parentId, mime) {
	if (mime == null) return;
	if (!classCount.has(parentId)) classCount.set(parentId, new Int32Array(4));
	classCount.get(parentId)[CLASS_INDEX[classOf(mime)]] += 1;
}
function removeClassCount(classCount, parentId, mime) {
	if (mime == null) return;
	const arr = classCount.get(parentId);
	if (!arr) return;
	arr[CLASS_INDEX[classOf(mime)]] -= 1;
}

// Θ(1) — три сравнения с нулём (ALGO.MD §3.5). "other" (индекс 3) наружу не
// выставляется — для него нет UI-кнопки (MEDIA-SPEC.md §3.10).
export function classesPresent(S, parentId) {
	const arr = S.classCount.get(parentId);
	return {
		audio: !!arr && arr[0] > 0,
		video: !!arr && arr[1] > 0,
		image: !!arr && arr[2] > 0,
	};
}

// children/namesInDir — индексы по ЖИВЫМ (не purged) узлам, ALGO.MD §6:
// "children... устраняет Θ(n) на листинг", "namesInDir... устраняет Θ(k²)
// при массовой загрузке". Найдено этой сессией бенчмарком (задача 3.9,
// TASK.md §11) — БЕЗ индекса ops.js's nameFree сканировал ВСЕ n узлов на
// КАЖДЫЙ createFolder/rename/move, превращая массовую загрузку в Θ(n²).
// Индексы — производные от nodes (как кэш project() — "не хранится в БД,
// живёт в памяти"), поддерживаются ИНКРЕМЕНТАЛЬНО, O(1) на операцию.
//
// Мутируются ПРЯМО, без клонирования (см. applyOp ниже) — Set/Map для
// одной папки МЕЛКИЕ (пропорциональны числу СОСЕДЕЙ в этой папке, не
// общему n), но полное клонирование ВНЕШНЕЙ Map/nodes на каждый вызов —
// именно то, что делало applyOp самим по себе Θ(n) за вызов (независимо
// от индексов выше) и превращало массовую вставку k узлов в Θ(k·n) —
// найдено ЭТИМ ЖЕ бенчмарком уже ПОСЛЕ добавления индексов (10⁴
// последовательных createFolder всё ещё занимали ~5.7с).
function addToIndex(children, namesInDir, parentId, id, name) {
	if (!children.has(parentId)) children.set(parentId, new Set());
	children.get(parentId).add(id);
	if (!namesInDir.has(parentId)) namesInDir.set(parentId, new Map());
	namesInDir.get(parentId).set(name, id);
}
function removeFromIndex(children, namesInDir, parentId, id, name) {
	children.get(parentId)?.delete(id);
	namesInDir.get(parentId)?.delete(name);
}

// Живые дети parentId — O(1) обращение к индексу вместо скана S.nodes.
export function liveChildrenOf(S, parentId) {
	return S.children.get(parentId) ?? new Set();
}
// Существует ли уже живой узел с именем name в parentId — O(1).
export function nameOwnerInDir(S, parentId, name) {
	return S.namesInDir.get(parentId)?.get(name);
}

// Начальное состояние — три системных узла, метка $system/0 (никогда не
// участвует в реальном сравнении: ничто пользовательское не должно иметь
// counter=0 у настоящего устройства, т.к. лампорт-часы стартуют с tick()=1,
// но даже при коллизии compareLabels детерминирована и не роняет инвариант).
export function createInitialState() {
	const sysLabel = { counter: 0, deviceId: "$system" };
	const nodes = new Map();
	const children = new Map();
	const namesInDir = new Map();

	function insert(node) {
		nodes.set(node.id, node);
		addToIndex(children, namesInDir, node.par.value, node.id, node.name.value);
	}
	insert(mkNode(ROOT_ID, "dir", null, null, "", sysLabel));
	insert(mkNode(TRASH_ID, "dir", null, ROOT_ID, "Корзина", sysLabel));
	insert(mkNode(LOST_FOUND_ID, "dir", null, ROOT_ID, "lost+found", sysLabel));

	return { nodes, children, namesInDir, classCount: new Map(), pending: new Map() };
}

// Пересобирает children/namesInDir/classCount с нуля из nodes — O(n), один
// раз (не на операцию). Нужен store.js: персистируется только nodes
// (индексы — производные, как и кэш project(), не хранятся в БД).
export function rebuildIndexes(nodes) {
	const children = new Map();
	const namesInDir = new Map();
	const classCount = new Map();
	for (const node of nodes.values()) {
		if (node.purged) continue;
		addToIndex(children, namesInDir, node.par.value, node.id, node.name.value);
		if (node.kind === "file") addClassCount(classCount, node.par.value, node.mime);
	}
	return { children, namesInDir, classCount };
}

// Независимая копия состояния — ЕДИНСТВЕННЫЙ способ получить снимок,
// который применение операций к оригиналу не заденет (см. примечание про
// мутацию у applyOp ниже). O(n) — используется редко и осознанно (тесты с
// несколькими "параллельными" репликами от одной точки), не на каждую
// операцию.
export function cloneState(S) {
	return {
		nodes: new Map(S.nodes),
		children: new Map([...S.children].map(([k, v]) => [k, new Set(v)])),
		namesInDir: new Map([...S.namesInDir].map(([k, v]) => [k, new Map(v)])),
		classCount: new Map([...S.classCount].map(([k, v]) => [k, Int32Array.from(v)])),
		pending: new Map(S.pending),
	};
}

// applyOp — единственная точка изменения состояния. МУТИРУЕТ nodes/
// children/namesInDir/pending ВНУТРИ переданного S (не клонирует их) —
// найдено бенчмарком (задача 3.9, TASK.md §11): полное клонирование Map
// из n записей на КАЖДЫЙ вызов делало саму функцию Θ(n), а значит массовую
// вставку k узлов — Θ(k·n) вместо Θ(k). Возвращается НОВАЯ обёртка (другая
// ссылка верхнего уровня — нужно сигналам/@preact/signals, сравнивающим по
// ссылке), но внутренние Map — ТЕ ЖЕ объекты: старая ссылка на S после
// вызова больше не снимок, а алиас на уже изменившееся состояние. Кому
// нужен настоящий независимый снимок ДО применения операций — cloneState()
// явно (напр. property-тест с несколькими "репликами" от одной точки).
//
// Порядок доставки произволен (TASK.md §6): setPar/setName/setOrigin/purge
// на ещё не увиденный NodeId буферизуются в S.pending и применяются, как
// только приходит соответствующий create — иначе операция, обогнавшая свой
// create, была бы потеряна навсегда (нарушение I-CONVERGE при
// определённых перестановках доставки).
export function applyOp(S, op) {
	const { nodes, children, namesInDir, classCount, pending } = S;

	if (op.type === "create") {
		if (nodes.has(op.id)) return { nodes, children, namesInDir, classCount, pending }; // идемпотентный повтор
		const node = mkNode(op.id, op.kind, op.blob ?? null, op.parentId, op.name, op.label, op.origin ?? null, op.mime ?? null);
		nodes.set(op.id, node);
		addToIndex(children, namesInDir, op.parentId, op.id, op.name);
		if (op.kind === "file") addClassCount(classCount, op.parentId, node.mime);
		const queued = pending.get(op.id);
		if (queued) {
			pending.delete(op.id);
			let s = { nodes, children, namesInDir, classCount, pending };
			for (const q of queued) s = applyOp(s, q);
			return s;
		}
		return { nodes, children, namesInDir, classCount, pending };
	}

	if (op.type === "setPar" || op.type === "setName" || op.type === "setOrigin") {
		const node = nodes.get(op.id);
		if (!node) {
			pending.set(op.id, [...(pending.get(op.id) ?? []), op]);
			return { nodes, children, namesInDir, classCount, pending };
		}
		const field = op.type === "setPar" ? "par" : op.type === "setName" ? "name" : "origin";
		const updatedReg = lwwMerge(node[field], op.value, op.label);
		if (updatedReg === node[field]) {
			// Метка не выиграла (устаревшая/повторная доставка) — индексы
			// трогать нечего, значение не изменилось.
			return { nodes, children, namesInDir, classCount, pending };
		}
		const updatedNode = { ...node, [field]: updatedReg };
		nodes.set(op.id, updatedNode);

		if (!node.purged) {
			if (field === "par") {
				removeFromIndex(children, namesInDir, node.par.value, op.id, node.name.value);
				addToIndex(children, namesInDir, updatedReg.value, op.id, node.name.value);
				if (node.kind === "file") {
					removeClassCount(classCount, node.par.value, node.mime);
					addClassCount(classCount, updatedReg.value, node.mime);
				}
			} else if (field === "name") {
				removeFromIndex(children, namesInDir, node.par.value, op.id, node.name.value);
				addToIndex(children, namesInDir, node.par.value, op.id, updatedReg.value);
			}
		}
		return { nodes, children, namesInDir, classCount, pending };
	}

	if (op.type === "purge") {
		const node = nodes.get(op.id);
		if (!node) {
			pending.set(op.id, [...(pending.get(op.id) ?? []), op]);
			return { nodes, children, namesInDir, classCount, pending };
		}
		if (node.purged) return { nodes, children, namesInDir, classCount, pending }; // монотонный флаг, идемпотентно
		nodes.set(op.id, { ...node, purged: true });
		removeFromIndex(children, namesInDir, node.par.value, op.id, node.name.value);
		if (node.kind === "file") removeClassCount(classCount, node.par.value, node.mime);
		return { nodes, children, namesInDir, classCount, pending };
	}

	// Дозаливка mime старому узлу (⊥→v) — DESIGN.md "Этап E, E1-доп".
	// Монотонное слияние: node.mime уже есть значение → идемпотентный no-op
	// (MEDIA-MATH.md Утв. 9 — независимые дозаливки одного узла вычисляют
	// ОДНО И ТО ЖЕ v, сравнивать нечего, второй приход не может нести другое
	// значение). БЕЗ label — тот же класс операции, что purge().
	if (op.type === "setMime") {
		const node = nodes.get(op.id);
		if (!node) {
			pending.set(op.id, [...(pending.get(op.id) ?? []), op]);
			return { nodes, children, namesInDir, classCount, pending };
		}
		if (node.mime != null) return { nodes, children, namesInDir, classCount, pending }; // уже есть значение
		nodes.set(op.id, { ...node, mime: op.value });
		if (!node.purged && node.kind === "file") addClassCount(classCount, node.par.value, op.value);
		return { nodes, children, namesInDir, classCount, pending };
	}

	throw new Error(`tree.js: неизвестный тип операции "${op.type}"`);
}

// Пакетное слияние (I-BATCH, ALGO.MD §14 последняя строка) — применяет ВСЮ
// пачку к S, project() вызывается ОДИН раз вызывающей стороной, не здесь.
export function merge(S, delta) {
	let s = S;
	for (const op of delta) s = applyOp(s, op);
	return s;
}

// project(S) = R из MATH.md §5.5/ALGO.MD §5.1 (багфикс indexOf -> pos-карта).
// Три шага в фиксированном порядке: разрыв циклов -> сироты (дети purged-
// узлов) -> коллизии имён. Θ(n), без скрытых констант. Работает НАПРЯМУЮ
// по nodes (не по children/namesInDir — те построены на ЖИВЫХ узлах в
// ТЕКУЩЕЙ, ещё не отремонтированной структуре par; шаг 1 обязан видеть
// ВСЕ узлы, включая с ещё не разорванными циклами).
export function project(S) {
	const { nodes } = S;
	const color = new Map(); // отсутствует в Map = white

	function parValue(id) {
		return nodes.get(id).par.value;
	}
	function parLabel(id) {
		return nodes.get(id).par.label;
	}

	// Шаг 1 — разрыв циклов.
	const brokenEdges = new Set();
	for (const id of nodes.keys()) {
		if (color.has(id)) continue;
		const path = [];
		const pos = new Map();
		let cur = id;
		while (cur !== null && cur !== undefined && nodes.has(cur) && !color.has(cur)) {
			pos.set(cur, path.length);
			color.set(cur, "gray");
			path.push(cur);
			cur = parValue(cur);
		}
		if (cur !== null && cur !== undefined && color.get(cur) === "gray") {
			const cycle = path.slice(pos.get(cur));
			let worst = cycle[0];
			for (const x of cycle) {
				if (compareLabels(parLabel(x), parLabel(worst)) < 0) worst = x;
			}
			brokenEdges.add(worst);
		}
		for (const m of path) color.set(m, "black");
	}

	function effectivePar(id) {
		if (id === ROOT_ID) return null;
		if (brokenEdges.has(id)) return ROOT_ID;
		return parValue(id);
	}

	// children по effectivePar — для обхода шага 2 (структурный, ещё не
	// финальный: сироты сюда попадают через "не посещено BFS-ом").
	const childrenByEffPar = new Map();
	for (const id of nodes.keys()) {
		if (id === ROOT_ID) continue;
		const p = effectivePar(id);
		if (!childrenByEffPar.has(p)) childrenByEffPar.set(p, []);
		childrenByEffPar.get(p).push(id);
	}

	// Шаг 2 — сироты: BFS от корня, НЕ спускается через purged-узлы (их
	// дети остаются непосещёнными -> сироты, см. DESIGN.md — "дети
	// очищенных узлов" буквально означает purged, не что-то ещё).
	const reachable = new Set([ROOT_ID]);
	const queue = [ROOT_ID];
	while (queue.length > 0) {
		const cur = queue.shift();
		if (nodes.get(cur).purged) continue;
		for (const child of childrenByEffPar.get(cur) ?? []) {
			if (!reachable.has(child)) {
				reachable.add(child);
				queue.push(child);
			}
		}
	}

	function finalParent(id) {
		if (id === ROOT_ID) return null;
		if (!reachable.has(id)) return LOST_FOUND_ID;
		return effectivePar(id);
	}

	// Живые (не purged) узлы — единственные, что попадают в проекцию.
	const liveIds = [...nodes.keys()].filter((id) => !nodes.get(id).purged);

	// children по финальному родителю, только среди живых.
	const children = new Map();
	for (const id of liveIds) {
		if (id === ROOT_ID) continue;
		const p = finalParent(id);
		if (!children.has(p)) children.set(p, []);
		children.get(p).push(id);
	}

	// Шаг 3 — коллизии имён: сортировка конфликтующих по (label, id),
	// суффикс существует только в проекции.
	const displayNames = new Map();
	for (const [parentId, kids] of children) {
		const byName = new Map();
		for (const kid of kids) {
			const nm = nodes.get(kid).name.value;
			if (!byName.has(nm)) byName.set(nm, []);
			byName.get(nm).push(kid);
		}
		for (const [nm, dup] of byName) {
			if (dup.length === 1) {
				displayNames.set(dup[0], nm);
				continue;
			}
			const sorted = dup.slice().sort((x, y) => {
				const c = compareLabels(nodes.get(x).name.label, nodes.get(y).name.label);
				if (c !== 0) return c;
				return x < y ? -1 : x > y ? 1 : 0;
			});
			sorted.forEach((id, i) => {
				displayNames.set(id, i === 0 ? nm : `${nm} (${i + 1})`);
			});
		}
	}

	const outNodes = new Map();
	for (const id of liveIds) {
		const n = nodes.get(id);
		let status = "ok";
		if (!reachable.has(id)) status = "orphaned";
		else if (brokenEdges.has(id)) status = "repaired";
		else if (displayNames.get(id) !== n.name.value) status = "renamed";
		outNodes.set(id, {
			parent: finalParent(id),
			displayName: displayNames.get(id) ?? n.name.value,
			kind: n.kind,
			blob: n.blob,
			origin: n.origin.value,
			mime: n.mime,
			status,
		});
	}

	return { nodes: outNodes, children, version: liveIds.length };
}
