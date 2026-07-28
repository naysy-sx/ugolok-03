import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { createInitialState, merge, project, ROOT_ID } from "../src/domain/files/tree.js";
import { createFolder } from "../src/domain/files/ops.js";
import { saveTreeState, loadTreeState } from "../src/domain/files/store.js";

const OWNER = "owner-batch";

beforeEach(async () => {
	await db.table("files_nodes").clear();
});

// I-BATCH (задача 2.7 TASK.md): "загрузка 100 файлов — одна транзакция, один
// пересчёт R". merge() сам по себе НЕ вызывает project() ни разу (то есть
// пересчёт R остаётся полностью в руках вызывающей стороны — merge() не
// может случайно сделать его Θ(m·n) вместо одного Θ(n)); здесь проверяем это
// прямым счётчиком вызовов, а не рассуждением в комментарии.
test("I-BATCH: merge() пачки из 100 операций НЕ вызывает project() ни разу — пересчёт R делает вызывающая сторона один раз", () => {
	let projectCallCount = 0;
	const countingProject = (S) => {
		projectCallCount += 1;
		return project(S);
	};

	// Имена уникальны по построению (f0..f99) — предусловие createFolder
	// проверяется против одного и того же начального (пустого) состояния без
	// накопления: для ЭТОГО теста важна форма пачки операций, не сценарий
	// конфликтов имён (тот покрыт tree-ops.test.js отдельно).
	const S0 = createInitialState();
	const ops = [];
	for (let i = 0; i < 100; i++) {
		ops.push(createFolder(S0, ROOT_ID, `f${i}`, `file-${i}`, { counter: i + 1, deviceId: "d1" }));
	}

	const merged = merge(S0, ops); // ОДИН вызов merge на всю пачку — 0 обращений к project внутри него
	assert.equal(projectCallCount, 0, "merge() не должен сам вызывать project()");

	const R = countingProject(merged); // ровно ОДИН пересчёт R вызывающей стороной
	assert.equal(projectCallCount, 1);
	assert.equal(R.nodes.size, 103, "100 новых файлов + 3 системных узла (root/trash/lost+found)");
});

test("I-BATCH: saveTreeState пишет ОДНОЙ транзакцией независимо от числа узлов (не N отдельных транзакций)", async () => {
	let S = createInitialState();
	const ops = [];
	for (let i = 0; i < 100; i++) {
		ops.push(createFolder(S, ROOT_ID, `f${i}`, `file-${i}`, { counter: i + 1, deviceId: "d1" }));
	}
	S = merge(S, ops);

	let transactionCount = 0;
	const origTransaction = db.transaction.bind(db);
	db.transaction = (...args) => {
		transactionCount += 1;
		return origTransaction(...args);
	};
	try {
		await saveTreeState(OWNER, S);
	} finally {
		db.transaction = origTransaction;
	}
	assert.equal(transactionCount, 1, "saveTreeState обязана использовать ровно одну транзакцию на всю пачку");

	const loaded = await loadTreeState(OWNER);
	assert.equal(loaded.nodes.size, 103, "100 новых файлов + 3 системных узла (root/trash/lost+found)");
});

// I-NO-QUADRATIC (задача 3.9, ALGO.MD §14 первая строка таблицы): найдено
// РЕАЛЬНЫМ бенчмарком (scripts/files-tree-bench.mjs) — без индекса
// namesInDir в tree.js/ops.js's nameFree сканировал ВСЕ узлы на каждый
// createFolder, а applyOp клонировал ВЕСЬ nodes на каждый вызов — вместе
// это давало Θ(n²) на последовательную вставку (10⁴ узлов — 5.7с вместо
// единиц мс). Масштаб здесь маленький специально (не 10⁴, чтобы тест не
// растягивал npm test и не завис БЫ на регрессии) — соотношение времени
// при учетверении n всё равно чётко отличает Θ(n) от Θ(n²) (4× против 16×).
test("I-NO-QUADRATIC: последовательная вставка растёт ЛИНЕЙНО по n, не квадратично", () => {
	function timeInsert(n) {
		let S = createInitialState();
		const start = performance.now();
		for (let i = 0; i < n; i++) {
			const op = createFolder(S, ROOT_ID, `f${i}`, `id-${i}`, { counter: i + 1, deviceId: "d1" });
			S = merge(S, [op]);
		}
		return performance.now() - start;
	}

	const small = timeInsert(1000);
	const large = timeInsert(8000); // 8×
	// Θ(n) дал бы ×8, Θ(n²) — ×64 (откалибровано вручную на реальной
	// регрессии: с квадратичным nameFree это было ×57 при тех же n). Порог
	// ×20 — с запасом выше линейного шума, но чётко ниже квадратичного роста.
	const ratio = large / Math.max(small, 0.01);
	assert.ok(ratio < 20, `рост похож на квадратичный: ×${ratio.toFixed(1)} при 8-кратном росте n (small=${small.toFixed(2)}мс, large=${large.toFixed(2)}мс)`);
});
