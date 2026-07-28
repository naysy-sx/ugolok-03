// CRDT-дерево файлов — чистая логика, БЕЗ I/O (CONTRACTS.md, этап 53, §3.3
// TASK.md). Формализация и обоснование каждого шага — DESIGN.md, "Этап 53,
// И1". Три системных узла существуют с самого начала состояния — их
// размещение (в частности lost+found как отдельный узел vs подпапка корзины)
// оставлено открытым вопросом до И3 (MATH.md §12.4), здесь — просто три
// зарезервированных NodeId.
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

function mkNode(id, kind, blob, parValue, nameValue, label, originValue = null) {
	return {
		id,
		kind,
		blob,
		par: { value: parValue, label },
		name: { value: nameValue, label },
		origin: { value: originValue, label },
		purged: false,
	};
}

// Начальное состояние — три системных узла, метка $system/0 (никогда не
// участвует в реальном сравнении: ничто пользовательское не должно иметь
// counter=0 у настоящего устройства, т.к. лампорт-часы стартуют с tick()=1,
// но даже при коллизии compareLabels детерминирована и не роняет инвариант).
export function createInitialState() {
	const sysLabel = { counter: 0, deviceId: "$system" };
	const nodes = new Map();
	nodes.set(ROOT_ID, mkNode(ROOT_ID, "dir", null, null, "", sysLabel));
	nodes.set(TRASH_ID, mkNode(TRASH_ID, "dir", null, ROOT_ID, "Корзина", sysLabel));
	nodes.set(LOST_FOUND_ID, mkNode(LOST_FOUND_ID, "dir", null, ROOT_ID, "lost+found", sysLabel));
	return { nodes, pending: new Map() };
}

// applyOp — единственная точка изменения состояния. Порядок доставки
// произволен (TASK.md §6): setPar/setName/setOrigin/purge на ещё не
// увиденный NodeId буферизуются в S.pending и применяются, как только
// приходит соответствующий create — иначе операция, обогнавшая свой
// create, была бы потеряна навсегда (нарушение I-CONVERGE при
// определённых перестановках доставки).
export function applyOp(S, op) {
	const nodes = new Map(S.nodes);
	const pending = new Map(S.pending);

	if (op.type === "create") {
		if (nodes.has(op.id)) return { nodes, pending }; // идемпотентный повтор
		nodes.set(op.id, mkNode(op.id, op.kind, op.blob ?? null, op.parentId, op.name, op.label, op.origin ?? null));
		const queued = pending.get(op.id);
		if (queued) {
			pending.delete(op.id);
			let s = { nodes, pending };
			for (const q of queued) s = applyOp(s, q);
			return s;
		}
		return { nodes, pending };
	}

	if (op.type === "setPar" || op.type === "setName" || op.type === "setOrigin") {
		const node = nodes.get(op.id);
		if (!node) {
			pending.set(op.id, [...(pending.get(op.id) ?? []), op]);
			return { nodes, pending };
		}
		const field = op.type === "setPar" ? "par" : op.type === "setName" ? "name" : "origin";
		nodes.set(op.id, { ...node, [field]: lwwMerge(node[field], op.value, op.label) });
		return { nodes, pending };
	}

	if (op.type === "purge") {
		const node = nodes.get(op.id);
		if (!node) {
			pending.set(op.id, [...(pending.get(op.id) ?? []), op]);
			return { nodes, pending };
		}
		if (node.purged) return { nodes, pending }; // монотонный флаг, идемпотентно
		nodes.set(op.id, { ...node, purged: true });
		return { nodes, pending };
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
// узлов) -> коллизии имён. Θ(n), без скрытых констант.
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
			status,
		});
	}

	return { nodes: outNodes, children, version: liveIds.length };
}
