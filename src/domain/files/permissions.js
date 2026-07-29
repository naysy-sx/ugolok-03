// Решётка прав на поддерево (CONTRACTS.md/DESIGN.md, этап 53 И6, задача
// 6.2) — чистая логика, БЕЗ I/O (тот же принцип, что tree.js/ops.js, этап
// 53 И1). `none ⊏ read ⊏ write ⊏ own` — ЦЕПЬ (MATH.md §6.1), join = max
// по индексу. share() в v0.1 производит ТОЛЬКО read-гранты (TASK.md §5.5)
// — write/own существуют в типе ради будущего расширения, ни один путь
// кода их сегодня не производит для чужих узлов.
const LEVEL = { none: 0, read: 1, write: 2, own: 3 };
const LEVEL_NAME = ["none", "read", "write", "own"];

export function joinPerm(a, b) {
	return LEVEL_NAME[Math.max(LEVEL[a], LEVEL[b])];
}

const ASCEND_LIMIT = 128; // тот же предел, что ops.js's targetInsideSubtree

function ancestorChain(treeState, nodeId) {
	const chain = [];
	let cur = nodeId;
	let steps = 0;
	while (cur !== null && cur !== undefined && steps < ASCEND_LIMIT) {
		chain.push(cur);
		const node = treeState.nodes.get(cur);
		if (!node) break;
		cur = node.par.value;
		steps += 1;
	}
	return chain;
}

// grantsIndex: Map<NodeId, Map<Pubkey, Perm>> — ПРЯМЫЕ гранты без
// наследования (строится один раз из files_shares вызывающей стороной,
// не пересчитывается внутри — та же дисциплина, что "случайность/эффекты
// снаружи", tree.js/ops.js).
export function effectivePerm(grantsIndex, treeState, userId, nodeId) {
	const chain = ancestorChain(treeState, nodeId);
	let result = "none";
	for (let i = chain.length - 1; i >= 0; i--) {
		const local = grantsIndex.get(chain[i])?.get(userId) ?? "none";
		result = joinPerm(result, local);
	}
	return result;
}

// O(D) на подъём для самой папки + O(k) на детей (одно объединение
// каждый) = O(D+k), не O(k·D) наивного "подъём для каждого ребёнка
// отдельно" (ALGO.MD §11).
export function effectivePermForChildren(grantsIndex, treeState, userId, parentId, childIds) {
	const parentEff = effectivePerm(grantsIndex, treeState, userId, parentId);
	return childIds.map((childId) => {
		const local = grantsIndex.get(childId)?.get(userId) ?? "none";
		return joinPerm(parentEff, local);
	});
}

// Множество корней долей, покрывающих nodeId (DESIGN.md, этап 53 И6,
// задача 6.4) — тот же подъём, что effectivePerm, другая свёртка
// (множество, не join). Присутствие узла как ключа в grantsIndex ЗНАЧИТ
// "это корень какой-то доли" — share() не создаёт записей ни для чего,
// кроме своего собственного nodeId.
export function coveringShares(grantsIndex, treeState, nodeId) {
	const chain = ancestorChain(treeState, nodeId);
	const result = new Set();
	for (const id of chain) {
		if (grantsIndex.has(id)) result.add(id);
	}
	return result;
}
