import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, applyOp, merge, project, ROOT_ID } from "../src/domain/files/tree.js";
import { createFolder, rename, move, remove, PreconditionError } from "../src/domain/files/ops.js";

// mulberry32 — зерно фиксируется, сценарий воспроизводится по номеру
// (TASK.md, задача 1.5: "зерно фиксируется, сценарий воспроизводится по
// номеру"). В проекте нет готового сидированного ГПСЧ (проверено —
// bench/tests используют голый Math.random()), поэтому свой, минимальный.
function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick(rng, arr) {
	return arr[Math.floor(rng() * arr.length)];
}

// Каждая реплика стартует от ОДНОГО общего S0 (уже синхронизированы), затем
// генерирует операции НЕЗАВИСИМО — своя копия локального состояния, не видит
// ходов других реплик. Это и моделирует настоящую офлайн-конкурентность:
// без этого приёма две реплики никогда бы не сгенерировали конфликтующие
// операции над ОДНИМ и тем же узлом (move()'s предусловие само отклонило бы
// уже-примененный конфликт при последовательной генерации — ловушка, из-за
// которой первая версия этого генератора не находила ничего интересного).
function generateScenario(seed, numReplicas, opsPerReplica) {
	const rng = mulberry32(seed);
	let S0 = createInitialState();
	const baseIds = [ROOT_ID];
	// Небольшая общая структура ДО расхождения реплик — иначе реплики редко
	// целятся в один и тот же существующий узел.
	for (let i = 0; i < 4; i++) {
		const newId = `base-${i}`;
		const op = createFolder(S0, pick(rng, baseIds), `base${i}`, newId, { counter: 0, deviceId: "$seed" });
		if (!(op instanceof PreconditionError)) {
			S0 = applyOp(S0, op);
			baseIds.push(newId);
		}
	}

	const allOps = [];
	for (let r = 0; r < numReplicas; r++) {
		const deviceId = `device-${r}`;
		let localS = S0;
		let counter = 0;
		const knownIds = [...baseIds];
		for (let step = 0; step < opsPerReplica; step++) {
			counter += 1;
			const label = { counter, deviceId };
			const kind = rng();
			let op;
			if (kind < 0.35) {
				const parentId = pick(rng, knownIds);
				const newId = `${deviceId}-${step}-${Math.floor(rng() * 1e6).toString(36)}`;
				op = createFolder(localS, parentId, `f${Math.floor(rng() * 8)}`, newId, label);
				if (!(op instanceof PreconditionError)) knownIds.push(newId);
			} else if (kind < 0.55) {
				const targetId = pick(rng, knownIds);
				if (targetId === ROOT_ID) continue;
				op = rename(localS, targetId, `r${Math.floor(rng() * 8)}`, label);
			} else if (kind < 0.85) {
				const nId = pick(rng, knownIds);
				const dId = pick(rng, knownIds);
				if (nId === ROOT_ID) continue;
				op = move(localS, nId, dId, label);
			} else {
				const targetId = pick(rng, knownIds);
				if (targetId === ROOT_ID) continue;
				op = remove(localS, targetId, label);
			}
			if (op && !(op instanceof PreconditionError)) {
				localS = applyOp(localS, op);
				allOps.push(op);
			}
		}
	}
	return allOps;
}

function shuffle(rng, arr) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function sortedEntries(R) {
	return [...R.nodes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const SCENARIOS = 1000; // TASK.md §11, задача 1.6: "на 10³ случайных сценариях"

test(`I-CONVERGE: ${SCENARIOS} случайных сценариев — любая перестановка доставки даёт одинаковый R`, () => {
	for (let seed = 0; seed < SCENARIOS; seed++) {
		const ops = generateScenario(seed, 3, 8);
		const rng = mulberry32(seed * 7919 + 1);
		const order1 = shuffle(rng, ops);
		const order2 = shuffle(rng, ops);

		const R1 = project(merge(createInitialState(), order1));
		const R2 = project(merge(createInitialState(), order2));
		assert.deepEqual(sortedEntries(R1), sortedEntries(R2), `seed=${seed}: разные перестановки доставки разошлись`);
	}
});

test(`I-IDEMPOTENT: ${SCENARIOS} случайных сценариев — повторная доставка (дубли) не меняет результат`, () => {
	for (let seed = 0; seed < SCENARIOS; seed++) {
		const ops = generateScenario(seed, 2, 6);
		const rng = mulberry32(seed * 104729 + 3);
		const withDupes = shuffle(rng, [...ops, ...ops]); // каждая операция дважды, вперемешку
		const withoutDupes = shuffle(rng, ops);

		const R1 = project(merge(createInitialState(), withDupes));
		const R2 = project(merge(createInitialState(), withoutDupes));
		assert.deepEqual(sortedEntries(R1), sortedEntries(R2), `seed=${seed}: повторная доставка изменила результат`);
	}
});

test(`I-STABLE: ${SCENARIOS} случайных сценариев — project(project(S)) не пишет в S, повторный вызов даёт то же`, () => {
	for (let seed = 0; seed < SCENARIOS; seed++) {
		const ops = generateScenario(seed, 2, 6);
		const S = merge(createInitialState(), ops);
		const R1 = project(S);
		const R2 = project(S);
		assert.deepEqual(sortedEntries(R1), sortedEntries(R2), `seed=${seed}: повторный project(S) дал другой результат`);
	}
});

test(`I-ORDER-FREE: ${SCENARIOS} случайных сценариев — порядок вставки в S.nodes не влияет на project (MATH.md §5.5.1)`, () => {
	for (let seed = 0; seed < SCENARIOS; seed++) {
		const ops = generateScenario(seed, 2, 6);
		const S = merge(createInitialState(), ops);
		const reversed = { nodes: new Map([...S.nodes.entries()].reverse()), pending: new Map() };
		const R1 = project(S);
		const R2 = project(reversed);
		assert.deepEqual(sortedEntries(R1), sortedEntries(R2), `seed=${seed}: порядок обхода Map повлиял на результат`);
	}
});

test("постусловия I-ACYCLIC/I-REACHABLE/I-UNIQUE-NAME держатся на 200 случайных сценариях покрупнее", () => {
	for (let seed = 0; seed < 200; seed++) {
		const ops = generateScenario(seed, 4, 15);
		const R = project(merge(createInitialState(), ops));

		for (const nodeId of R.nodes.keys()) {
			let cur = nodeId;
			let steps = 0;
			while (cur !== null && steps < 500) {
				cur = R.nodes.get(cur).parent;
				steps += 1;
			}
			assert.ok(cur === null, `seed=${seed}: узел ${nodeId} не достигает корня (I-REACHABLE/I-ACYCLIC)`);
		}
		for (const [, kids] of R.children) {
			const names = kids.map((k) => R.nodes.get(k).displayName);
			assert.equal(new Set(names).size, names.length, `seed=${seed}: дубль displayName в одной папке`);
		}
	}
});
