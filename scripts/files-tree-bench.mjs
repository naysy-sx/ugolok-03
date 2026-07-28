#!/usr/bin/env node
// Замер бюджетов §8 TASK.md / инвариантов производительности §9.1 MATH.md
// для CRDT-дерева файлов (domain/files/tree.js). Чистая логика — в отличие
// от p-spike-bench.mjs (тот гоняет crypto.worker/IndexedDB через реальный
// браузер), здесь браузер не нужен: tree.js не делает I/O вообще.
//
// Использование: node scripts/files-tree-bench.mjs

import { createInitialState, applyOp, merge, project, ROOT_ID } from "../src/domain/files/tree.js";
import { createFolder } from "../src/domain/files/ops.js";

// §8 TASK.md даёт явный бюджет ТОЛЬКО для n=10⁴ (<16мс). n=10⁵ — "потолок"
// (ALGO.MD §2), для которого сами авторы предполагают ДРУГУЮ стратегию
// (ленивая загрузка состояния, ALGO.MD §20 п.2), не тот же project() над
// всем n сразу — поэтому n=10⁵ здесь ИНФОРМАЦИОННЫЙ замер, не хард-бюджет.
const R_BUDGET_MS = { 1000: 16, 10000: 16 };
const MAIN_THREAD_BUDGET_MS = 50; // I-MAIN-THREAD, §8 TASK.md

function timeIt(fn) {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

function buildFlatTree(n) {
	let S = createInitialState();
	for (let i = 0; i < n; i++) {
		const op = createFolder(S, ROOT_ID, `f${i}`, `id-${i}`, { counter: i + 1, deviceId: "bench-device" });
		S = applyOp(S, op);
	}
	return S;
}

console.log("=== I-R-BUDGET: полный project(S) при разных n (§8 TASK.md) ===");
let allROk = true;
for (const n of [1000, 10000, 100000]) {
	const S = buildFlatTree(n);
	// Первый вызов — прогрев (JIT), замеряем следующие 3, берём медиану (тот
	// же принцип, что бенчмарки обычно используют против шума первого прогона).
	project(S);
	const times = [1, 2, 3].map(() => timeIt(() => project(S)));
	times.sort((a, b) => a - b);
	const median = times[1];
	const budget = R_BUDGET_MS[n];
	if (budget === undefined) {
		console.log(`n=${n}: ${median.toFixed(2)} мс (информационно — нет хард-бюджета, см. комментарий выше)`);
		continue;
	}
	const ok = median <= budget;
	allROk = allROk && ok;
	console.log(`n=${n}: ${median.toFixed(2)} мс (бюджет ${budget} мс) — ${ok ? "OK" : "ПРЕВЫШЕН"}`);
}

console.log("\n=== I-NO-QUADRATIC: вставка p узлов в ОДНУ папку — линейно по p (§8 TASK.md) ===");
function timeInsert(p) {
	let S = createInitialState();
	return timeIt(() => {
		for (let i = 0; i < p; i++) {
			const op = createFolder(S, ROOT_ID, `f${i}`, `id-${i}`, { counter: i + 1, deviceId: "bench-device" });
			S = applyOp(S, op);
		}
	});
}
const t1k = timeInsert(1000);
const t2k = timeInsert(2000);
const t4k = timeInsert(4000);
// Квадратичный рост дал бы кратно БОЛЬШЕ чем 2×/4× при удвоении/учетверении p
// (Θ(p²): 2p -> ×4, 4p -> ×16). Линейный — ×2/×4 с запасом на шум.
const ratio2x = t2k / t1k;
const ratio4x = t4k / t1k;
const linearOk = ratio2x < 3 && ratio4x < 6; // щедрый запас, не точное равенство — цель поймать Θ(p²), не придираться к шуму
console.log(`p=1000: ${t1k.toFixed(2)} мс`);
console.log(`p=2000: ${t2k.toFixed(2)} мс (×${ratio2x.toFixed(2)} от p=1000)`);
console.log(`p=4000: ${t4k.toFixed(2)} мс (×${ratio4x.toFixed(2)} от p=1000)`);
console.log(linearOk ? "OK — рост похож на линейный, не квадратичный" : "ПРЕВЫШЕН — похоже на Θ(p²), см. namesInDir/children индексы");

console.log("\n=== I-BATCH / слияние m=1000 операций одной пачкой (без project() внутри merge) ===");
function buildOpsBatch(m) {
	let S = createInitialState();
	const ops = [];
	for (let i = 0; i < m; i++) {
		const op = createFolder(S, ROOT_ID, `f${i}`, `id-${i}`, { counter: i + 1, deviceId: "bench-device" });
		S = applyOp(S, op);
		ops.push(op);
	}
	return ops;
}
const batchOps = buildOpsBatch(1000);
const mergeTime = timeIt(() => merge(createInitialState(), batchOps));
console.log(`merge(1000 операций): ${mergeTime.toFixed(2)} мс`);
const mergeOk = mergeTime <= MAIN_THREAD_BUDGET_MS;
console.log(`бюджет I-MAIN-THREAD (${MAIN_THREAD_BUDGET_MS} мс на операцию, здесь — на всю пачку из 1000): ${mergeOk ? "OK" : "ПРЕВЫШЕН"}`);

console.log("\n=== Итог ===");
const allOk = allROk && linearOk && mergeOk;
console.log(allOk ? "Все бюджеты И3 (задача 3.9) подтверждены при текущем масштабе." : "Есть превышения — см. вывод выше.");
if (!allOk) process.exitCode = 1;
